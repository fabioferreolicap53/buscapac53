import React, { useEffect, useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle, Pause, Play, Square, RotateCcw } from 'lucide-react';
import { DataService, pb, ensureDnsResolves } from '../services/DataService';
import Papa from 'papaparse';
import { normalizeString } from '../utils/stringUtils';

const PARSE_CHUNK_SIZE = 4 * 1024 * 1024;
// Registros por requisição enviados ao hook (/api/buscapac53/import-pacientes).
// O backend monta UM INSERT multi-linha (1 transação atômica), então lotes
// maiores = menos overhead de rede e lock mais curto no SQLite.
const IMPORT_CHUNK = 1000;
// Trégua curta entre lotes para o servidor compartilhado respirar.
const PAUSE_MS = 40;
const PAUSE_POLL_MS = 200;
const PROGRESS_REPORT_STEP = 500;
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_SIZE_LABEL = '1GB';

// Campos da coleção buscapac53_pacientes, na ordem do cabeçalho do CSV.
// Usada como fallback posicional quando o arquivo não traz linha de cabeçalho.
const CAMPOS_PACIENTE: string[] = [
  'NOME_UNIDADE_DE_SAUDE',
  'NOME_EQUIPE_DE_SAUDE',
  'CODIGO_MICROAREA',
  'N_CNS_DA_PESSOA_CADASTRADA',
  'NOME_DA_PESSOA_CADASTRADA',
  'NOME_DA_MAE_PESSOA_CADASTRADA',
  'DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO',
  'SITUACAO_USUARIO',
  'SEXO',
  'DATA_DE_NASCIMENTO',
  'TIPO_DE_LOGRADOURO',
  'LOGRADOURO',
  'CEP_LOGRADOURO',
  'BAIRRO_DE_MORADIA',
  'N_CPF',
  'RACA_COR',
];

// Cabeçalhos alternativos aceitos (comparados após normalizeString).
const ALIASES_CABECALHO: Record<string, string[]> = {
  NOME_UNIDADE_DE_SAUDE: ['UNIDADE', 'UNIDADE DE SAUDE', 'ESTABELECIMENTO', 'UBS'],
  NOME_EQUIPE_DE_SAUDE: ['EQUIPE', 'EQUIPE DE SAUDE'],
  CODIGO_MICROAREA: ['MICROAREA', 'MICRO AREA', 'CODIGO DA MICROAREA'],
  N_CNS_DA_PESSOA_CADASTRADA: ['CNS', 'CARTAO SUS', 'NUMERO CNS', 'CNS DA PESSOA CADASTRADA'],
  NOME_DA_PESSOA_CADASTRADA: ['NOME', 'NOME PACIENTE', 'NOME DO PACIENTE', 'PACIENTE', 'NOME COMPLETO'],
  NOME_DA_MAE_PESSOA_CADASTRADA: ['NOME DA MAE', 'MAE', 'NOME MAE'],
  DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO: ['DATA ULTIMA ATUALIZACAO', 'ULTIMA ATUALIZACAO', 'ULT ATUALIZACAO'],
  SITUACAO_USUARIO: ['SITUACAO', 'SITUACAO DO USUARIO'],
  SEXO: ['SEXO', 'GENERO'],
  DATA_DE_NASCIMENTO: ['DATA DE NASCIMENTO', 'DATA NASCIMENTO', 'NASCIMENTO', 'NASC'],
  TIPO_DE_LOGRADOURO: ['TIPO DE LOGRADOURO', 'TIPO LOGRADOURO'],
  LOGRADOURO: ['LOGRADOURO', 'ENDERECO'],
  CEP_LOGRADOURO: ['CEP', 'CEP DO LOGRADOURO'],
  BAIRRO_DE_MORADIA: ['BAIRRO', 'BAIRRO DE MORADIA'],
  N_CPF: ['CPF', 'CPF DO USUARIO', 'NUMERO DO CPF', 'N_CPF'],
  RACA_COR: ['RACA', 'RACA COR', 'COR DA PELE', 'RACA/COR', 'ETNIA'],
};

const MIN_CAMPOS_CABECALHO = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const formatDuration = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
};

const somenteDigitos = (valor: string) => valor.replace(/\D/g, '');

// Converte datas do CSV para DD/MM/AAAA (formato usado na exibição e na ordenação).
const formatarData = (valor: string): string => {
  const raw = (valor || '').trim();
  if (!raw || raw === '--') return '';

  const iso = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    return `${iso[3].padStart(2, '0')}/${iso[2].padStart(2, '0')}/${iso[1]}`;
  }

  const br = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (br) {
    const ano = br[3].length === 2 ? `20${br[3]}` : br[3];
    return `${br[1].padStart(2, '0')}/${br[2].padStart(2, '0')}/${ano}`;
  }

  const digitos = somenteDigitos(raw);
  if (digitos.length === 8) {
    const inicio = digitos.slice(0, 4);
    if (inicio >= '1900' && inicio <= '2100') {
      return `${digitos.slice(6, 8)}/${digitos.slice(4, 6)}/${inicio}`;
    }
    return `${digitos.slice(0, 2)}/${digitos.slice(2, 4)}/${digitos.slice(4, 8)}`;
  }

  return '';
};

const sanitizarValor = (campo: string, valorBruto: string): string => {
  const valor = String(valorBruto ?? '').trim().replace(/^"|"$/g, '').trim();

  switch (campo) {
    case 'DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO':
    case 'DATA_DE_NASCIMENTO':
      return formatarData(valor);
    case 'N_CNS_DA_PESSOA_CADASTRADA':
    case 'CEP_LOGRADOURO':
      return somenteDigitos(valor);
    case 'N_CPF': {
      const digitos = somenteDigitos(valor);
      return digitos.length === 11 ? digitos : '';
    }
    default:
      return normalizeString(valor);
  }
};

// Mapeia cada coluna do cabeçalho para um campo da coleção (null = coluna ignorada).
const mapearCabecalho = (row: string[]): (string | null)[] => {
  const cabecalhos = row.map((h) => normalizeString(String(h ?? '')));
  const mapa: (string | null)[] = cabecalhos.map(() => null);

  cabecalhos.forEach((cabecalho, i) => {
    if (!cabecalho) return;
    const campo = CAMPOS_PACIENTE.find((f) => normalizeString(f) === cabecalho);
    if (campo) mapa[i] = campo;
  });

  cabecalhos.forEach((cabecalho, i) => {
    if (!cabecalho || mapa[i]) return;

    for (const campo of CAMPOS_PACIENTE) {
      if (mapa.includes(campo)) continue;

      const alias = [campo, ...(ALIASES_CABECALHO[campo] || [])].some((candidato) => {
        const alvo = normalizeString(candidato);
        return alvo === cabecalho || cabecalho.includes(alvo) || alvo.includes(cabecalho);
      });

      if (alias) {
        mapa[i] = campo;
        return;
      }
    }
  });

  return mapa;
};

const montarRegistro = (row: string[], colunas: (string | null)[]): Record<string, string> => {
  const registro: Record<string, string> = {};

  for (let i = 0; i < colunas.length; i++) {
    const campo = colunas[i];
    if (!campo || registro[campo] !== undefined) continue;

    const valor = sanitizarValor(campo, row[i]);
    if (valor !== '') registro[campo] = valor;
  }

  return registro;
};

// Descobre o delimitador das primeiras linhas do arquivo. Suporta CSV separado
// por ponto e vírgula (';') — padrão da base exportada — e por vírgula.
const detectarDelimitador = async (file: File): Promise<string> => {
  try {
    const texto = await file.slice(0, 65536).text();
    const primeiraLinhaUtil = texto.split(/\r?\n/).find((linha) => linha.trim().length > 0) || '';
    const pontoVirgula = (primeiraLinhaUtil.match(/;/g) || []).length;
    const virgula = (primeiraLinhaUtil.match(/,/g) || []).length;
    return pontoVirgula >= virgula && pontoVirgula > 0 ? ';' : ',';
  } catch {
    return ';';
  }
};

// Conta as linhas de dados do CSV (ignora cabeçalho e linhas vazias).
// Leitura prévia para o percentual refletir a quantidade real de registros.
const contarRegistros = (
  file: File,
  delimiter: string,
  onProgress?: (linhas: number) => void
): Promise<number> => {
  return new Promise((resolve) => {
    let linhas = 0;
    let cabecalhoLido = false;

    Papa.parse(file, {
      header: false,
      skipEmptyLines: 'greedy',
      worker: false,
      encoding: 'CP1252',
      delimiter,
      chunkSize: PARSE_CHUNK_SIZE,
      chunk: (results) => {
        for (const row of results.data as string[][]) {
          if (!cabecalhoLido) {
            cabecalhoLido = true;
            if (mapearCabecalho(row).filter(Boolean).length >= MIN_CAMPOS_CABECALHO) {
              continue; // linha de cabeçalho
            }
          }

          if (row && row.length > 0) linhas++;
        }

        if (onProgress) onProgress(linhas);
      },
      complete: () => resolve(linhas),
      error: () => resolve(linhas)
    });
  });
};

const formatFileSize = (bytes: number) => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

interface CsvUploadProps {
  onSuccess?: () => void;
}

type UploadStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';
type UploadControl = 'running' | 'paused';

export default function CsvUpload({ onSuccess }: CsvUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [control, setControl] = useState<UploadControl>('running');
  const [progressText, setProgressText] = useState('Preparando...');
  const [progressPercent, setProgressPercent] = useState(0);
  const [eta, setEta] = useState('—');
  const [totalFileSize, setTotalFileSize] = useState(0);
  const [bytesProcessed, setBytesProcessed] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [processedRows, setProcessedRows] = useState(0);
  const [savedRows, setSavedRows] = useState(0);
  const [failedRows, setFailedRows] = useState(0);

  const mountedRef = useRef(true);
  // Cada execução recebe um token. Cancelar/reiniciar muda o token e a execução
  // antiga é descartada (a tela nunca fica travada).
  const runTokenRef = useRef(0);
  // Controle de fluxo assíncrono em ref (não state): sem stale closure.
  const flagsRef = useRef({ paused: false, cancelled: false });
  const abortRef = useRef<(() => void) | null>(null);
  const metricsRef = useRef({ processed: 0, saved: 0, failed: 0, total: 0 });
  const startTimeRef = useRef(0);
  const lastReportRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flagsRef.current.cancelled = true;
      if (abortRef.current) abortRef.current();
    };
  }, []);

  const atualizarEta = (processados: number, total: number) => {
    if (processados <= 0 || total <= 0) {
      setEta('—');
      return;
    }
    const elapsedSec = (Date.now() - startTimeRef.current) / 1000;
    if (elapsedSec <= 0) return;
    const restantes = Math.max(0, total - processados);
    const segundosRestantes = (elapsedSec / processados) * restantes;
    setEta(formatDuration(segundosRestantes));
  };

  const publicarProgresso = (force: boolean) => {
    if (!mountedRef.current) return;
    const { processed, saved, failed } = metricsRef.current;
    setProcessedRows(processed);
    setSavedRows(saved);
    setFailedRows(failed);

    const total = metricsRef.current.total;
    if (total > 0) {
      setProgressPercent(Math.min(99, 8 + Math.floor((processed / total) * 91)));
      atualizarEta(processed, total);
    }

    if (force || processed - lastReportRef.current >= PROGRESS_REPORT_STEP) {
      lastReportRef.current = processed;
      setProgressText(
        total > 0
          ? `Importando ${processed.toLocaleString()} de ${total.toLocaleString()} registros`
          : `${saved.toLocaleString()} salvos • ${failed} falhas`
      );
    }
  };

  const esperarSePausado = async () => {
    while (flagsRef.current.paused && !flagsRef.current.cancelled) {
      await sleep(PAUSE_POLL_MS);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Permite re-selecionar o mesmo arquivo depois.
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      alert(`O arquivo excede o limite de tamanho permitido (${MAX_FILE_SIZE_LABEL}). Tamanho do arquivo: ${formatFileSize(file.size)}`);
      return;
    }

    const token = ++runTokenRef.current;
    flagsRef.current = { paused: false, cancelled: false };
    metricsRef.current = { processed: 0, saved: 0, failed: 0, total: 0 };
    lastReportRef.current = 0;
    startTimeRef.current = Date.now();

    setStatus('running');
    setControl('running');
    setProgressText('Iniciando processamento...');
    setProgressPercent(0);
    setEta('—');
    setTotalFileSize(file.size);
    setBytesProcessed(0);
    setTotalRows(0);
    setProcessedRows(0);
    setSavedRows(0);
    setFailedRows(0);

    const tokenValido = () => mountedRef.current && runTokenRef.current === token;

    try {
      // 1. Autenticação (superuser) — necessária para o hook aceitar o lote.
      setProgressText('Autenticando...');
      setProgressPercent(4);
      await DataService.authenticate();

      // 2. Detecta o delimitador (ponto e vírgula ou vírgula).
      setProgressText('Analisando o arquivo...');
      setProgressPercent(6);
      const delimiter = await detectarDelimitador(file);
      if (!tokenValido()) return;

      // 3. Contagem prévia dos registros (para o percentual refletir as linhas).
      setProgressText('Contando registros do arquivo...');
      let totalRowsArquivo = 0;
      try {
        totalRowsArquivo = await contarRegistros(file, delimiter, (linhas) => {
          if (tokenValido()) setProgressText(`Contando registros... ${linhas.toLocaleString()}`);
        });
      } catch (contagemError) {
        console.error('Falha ao contar registros:', contagemError);
      }
      if (!tokenValido()) return;

      metricsRef.current.total = totalRowsArquivo;
      setTotalRows(totalRowsArquivo);
      setProgressText('Validando arquivo...');
      setProgressPercent(8);

      // 4. Parse em chunks + envio em lotes ao backend.
      let cabecalhoLido = false;
      let colunas: (string | null)[] = CAMPOS_PACIENTE;
      let primeiroLote = true;
      let buffer: Record<string, string>[] = [];
      let registrosValidosEnviados = 0;

      const enviarLote = async (lote: Record<string, string>[], modo: 'append' | 'replace') => {
        if (lote.length === 0) return;
        await esperarSePausado();
        if (flagsRef.current.cancelled) throw new Error('__CANCELLED__');

        const resultado = await DataService.importPatientsBatch(lote, modo);
        if (flagsRef.current.cancelled) throw new Error('__CANCELLED__');

        metricsRef.current.saved += resultado.imported;
        metricsRef.current.failed += Math.max(0, lote.length - resultado.imported);
        metricsRef.current.processed += lote.length;
        registrosValidosEnviados += lote.length;
        publicarProgresso(false);

        // Trégua entre lotes (não dorme se for cancelar/pausar na sequência).
        if (!flagsRef.current.cancelled) await sleep(PAUSE_MS);
      };

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (e: unknown) => {
          if (settled) return;
          settled = true;
          reject(e);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        Papa.parse(file, {
          header: false,
          skipEmptyLines: 'greedy',
          worker: false,
          encoding: 'CP1252',
          delimiter,
          chunkSize: PARSE_CHUNK_SIZE,
          chunk: async (results, papaParser) => {
            papaParser.pause();
            abortRef.current = () => papaParser.abort();

            try {
              if (flagsRef.current.cancelled) {
                papaParser.abort();
                return;
              }

              const rows = results.data as string[][];

              for (const row of rows) {
                if (!cabecalhoLido) {
                  cabecalhoLido = true;
                  const mapa = mapearCabecalho(row);

                  if (mapa.filter(Boolean).length >= MIN_CAMPOS_CABECALHO) {
                    colunas = mapa;
                    continue; // linha de cabeçalho
                  }

                  colunas = CAMPOS_PACIENTE;
                }

                const registro = montarRegistro(row, colunas);

                if (!registro.NOME_DA_PESSOA_CADASTRADA || !registro.N_CNS_DA_PESSOA_CADASTRADA) {
                  continue;
                }

                buffer.push(registro);

                if (buffer.length >= IMPORT_CHUNK) {
                  const lote = buffer;
                  buffer = [];
                  const modo = primeiroLote ? 'replace' : 'append';
                  await enviarLote(lote, modo);
                  primeiroLote = false;
                }
              }

              const newBytesProcessed = Math.min((results.meta as any)?.cursor || totalFileSize, totalFileSize);
              if (mountedRef.current) setBytesProcessed(newBytesProcessed);

              // Sem contagem prévia: progresso baseado nos bytes já lidos.
              if (totalRowsArquivo === 0 && totalFileSize > 0 && mountedRef.current) {
                setProgressPercent(Math.min(99, 8 + Math.floor((newBytesProcessed / totalFileSize) * 91)));
              }

              papaParser.resume();
            } catch (error) {
              papaParser.abort();
              fail(error);
            }
          },
          complete: async () => {
            if (settled || flagsRef.current.cancelled) return;

            try {
              if (buffer.length > 0) {
                const modo = primeiroLote ? 'replace' : 'append';
                await enviarLote(buffer, modo);
                primeiroLote = false;
                buffer = [];
              }

              if (registrosValidosEnviados === 0) {
                fail(new Error('Nenhum registro válido encontrado no arquivo.'));
                return;
              }

              // Histórico da importação (best-effort, não bloqueia o resultado).
              try {
                await ensureDnsResolves();
                await pb.collection('buscapac53_historico').create({
                  date: new Date().toLocaleString(),
                  count: metricsRef.current.saved,
                  fileName: file.name
                });
              } catch (hErr) {
                console.error('Erro ao salvar histórico:', hErr);
              }

              finish();
            } catch (error) {
              fail(error);
            }
          },
          error: (error) => fail(error)
        });
      });

      if (!tokenValido()) return;

      const { saved, failed, processed } = metricsRef.current;
      setProgressPercent(100);
      setProcessedRows(processed);
      setSavedRows(saved);
      setFailedRows(failed);
      setEta('0s');
      setProgressText(`Concluído! ${saved.toLocaleString()} salvos • ${failed.toLocaleString()} ignorados`);
      setStatus('success');
      if (onSuccess) onSuccess();
    } catch (error) {
      if (!tokenValido() || flagsRef.current.cancelled || (error instanceof Error && error.message === '__CANCELLED__')) {
        // Cancelado pelo usuário: volta à tela inicial sem erro.
        const { saved, failed } = metricsRef.current;
        setProgressText(`Importação cancelada. ${saved.toLocaleString()} salvos • ${failed.toLocaleString()} ignorados`);
        setStatus('cancelled');
        return;
      }

      console.error('Erro geral:', error);
      setStatus('error');
      setProgressText(error instanceof Error ? error.message : 'Falha no upload para PocketBase.');
    } finally {
      abortRef.current = null;
    }
  };

  const pausar = () => {
    flagsRef.current.paused = true;
    setControl('paused');
  };

  const retomar = () => {
    flagsRef.current.paused = false;
    setControl('running');
  };

  const cancelar = () => {
    flagsRef.current.cancelled = true;
    flagsRef.current.paused = false;
    if (abortRef.current) abortRef.current();
  };

  const resetar = () => {
    runTokenRef.current++;
    flagsRef.current = { paused: false, cancelled: false };
    setStatus('idle');
    setControl('running');
    setProgressPercent(0);
    setProgressText('Preparando...');
    setEta('—');
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 bg-white rounded-3xl border-2 border-dashed border-slate-200 transition-all hover:border-blue-400 hover:bg-blue-50/30 group/upload w-full h-full min-h-[200px]">
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={handleFileChange}
        className="hidden"
        ref={fileInputRef}
      />

      {status === 'idle' && (
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex flex-col items-center gap-4 w-full h-full justify-center"
        >
          <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-sm group-hover/upload:scale-110 group-hover/upload:bg-blue-600 group-hover/upload:text-white transition-all duration-300">
            <Upload size={28} strokeWidth={2.5} />
          </div>
          <div className="text-center">
            <p className="text-sm font-black text-slate-700 tracking-widest uppercase">Selecionar Arquivo</p>
            <p className="text-xs text-slate-400 mt-2 font-medium">CSV (separado por ponto e vírgula) até {MAX_FILE_SIZE_LABEL}</p>
          </div>
        </button>
      )}

      {status === 'running' && (
        <div className="flex flex-col items-center gap-4 w-full px-4">
          <div className="relative w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-sm">
            {control === 'paused' ? (
              <Pause size={28} strokeWidth={2.5} />
            ) : (
              <FileText size={28} strokeWidth={2.5} />
            )}
            <span className="absolute -bottom-2 -right-2 bg-[#001f3f] text-white text-[10px] font-black px-2 py-0.5 rounded-full tabular-nums shadow-sm">
              {progressPercent}%
            </span>
          </div>

          <div className="w-full text-center space-y-3">
            <p className={`text-[11px] font-black tracking-widest uppercase ${control === 'paused' ? 'text-amber-600' : 'text-blue-600 animate-pulse'}`}>
              {control === 'paused' ? 'Pausado — aguardando retomada' : progressText}
            </p>

            <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden relative">
              <div
                className={`h-2.5 rounded-full transition-all duration-500 ease-out relative ${control === 'paused' ? 'bg-amber-500' : 'bg-blue-600'}`}
                style={{ width: `${progressPercent}%` }}
              >
                <div className="absolute top-0 left-0 w-full h-full bg-white/20 animate-[shimmer_2s_infinite]" />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Salvos</p>
                <p className="text-sm font-black text-[#001f3f] tabular-nums">{savedRows.toLocaleString()}</p>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Ignorados</p>
                <p className={`text-sm font-black tabular-nums ${failedRows > 0 ? 'text-rose-600' : 'text-slate-300'}`}>
                  {failedRows.toLocaleString()}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Total</p>
                <p className="text-sm font-black text-slate-500 tabular-nums">{totalRows.toLocaleString()}</p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 text-[10px] font-bold text-slate-400">
              <span className="tabular-nums">
                {totalRows > 0
                  ? `${processedRows.toLocaleString()} de ${totalRows.toLocaleString()} registros`
                  : `${processedRows.toLocaleString()} registros processados`}
              </span>
              <span className="tabular-nums">ETA {eta}</span>
            </div>

            <div className="flex items-center justify-center gap-2 pt-1">
              {control === 'paused' ? (
                <button
                  onClick={retomar}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-blue-700 transition-colors"
                >
                  <Play size={13} strokeWidth={3} /> Retomar
                </button>
              ) : (
                <button
                  onClick={pausar}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500 text-white text-[10px] font-black uppercase tracking-widest hover:bg-amber-600 transition-colors"
                >
                  <Pause size={13} strokeWidth={3} /> Pausar
                </button>
              )}
              <button
                onClick={cancelar}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-rose-200 text-rose-600 text-[10px] font-black uppercase tracking-widest hover:bg-rose-50 transition-colors"
              >
                <Square size={13} strokeWidth={3} /> Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {status === 'success' && (
        <div className="flex flex-col items-center gap-4 animate-in zoom-in duration-300">
          <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center shadow-sm">
            <CheckCircle2 size={32} strokeWidth={2.5} />
          </div>
          <div className="text-center">
            <p className="text-[11px] font-black text-emerald-600 tracking-widest uppercase">Base Atualizada</p>
            <p className="text-xs text-slate-500 mt-1 font-medium">
              {savedRows.toLocaleString()} registros importados{failedRows > 0 ? ` • ${failedRows.toLocaleString()} ignorados` : ''}
            </p>
          </div>
          <button
            onClick={resetar}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors"
          >
            <RotateCcw size={13} strokeWidth={3} /> Importar outro arquivo
          </button>
        </div>
      )}

      {status === 'cancelled' && (
        <div className="flex flex-col items-center gap-4 animate-in zoom-in duration-300">
          <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center shadow-sm">
            <AlertCircle size={32} strokeWidth={2.5} />
          </div>
          <div className="text-center">
            <p className="text-[11px] font-black text-amber-600 tracking-widest uppercase">Importação Cancelada</p>
            <p className="text-xs text-slate-500 mt-1 font-medium max-w-[220px] leading-tight">{progressText}</p>
          </div>
          <button
            onClick={resetar}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors"
          >
            <RotateCcw size={13} strokeWidth={3} /> Recomeçar
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center gap-4 animate-in zoom-in duration-300">
          <div className="w-16 h-16 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center shadow-sm">
            <AlertCircle size={32} strokeWidth={2.5} />
          </div>
          <div className="text-center">
            <p className="text-[11px] font-black text-red-600 tracking-widest uppercase">Falha na Importação</p>
            <p className="text-xs text-slate-500 mt-1 font-medium max-w-[220px] leading-tight">{progressText}</p>
          </div>
          <button
            onClick={resetar}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-colors"
          >
            <RotateCcw size={13} strokeWidth={3} /> Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}
