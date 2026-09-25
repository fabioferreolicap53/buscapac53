
import React, { useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { DataService, pb, ensureDnsResolves } from '../services/DataService';
import Papa from 'papaparse';
import { normalizeString } from '../utils/stringUtils';

const PARSE_CHUNK_SIZE = 4 * 1024 * 1024;
const UPLOAD_BUFFER_SIZE = 480;
const PROGRESS_REPORT_STEP = 1000;
const MAX_FAILURES_BEFORE_ABORT = 20;
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
};

const MIN_CAMPOS_CABECALHO = 8;

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

// Conta as linhas de dados do CSV (ignora cabeçalho e linhas vazias).
// É uma leitura prévia do arquivo para que o percentual de progresso reflita
// a quantidade real de registros importados, e não os bytes lidos.
const contarRegistros = (file: File, onProgress?: (linhas: number) => void): Promise<number> => {
  return new Promise((resolve) => {
    let linhas = 0;
    let cabecalhoLido = false;

    Papa.parse(file, {
      header: false,
      skipEmptyLines: 'greedy',
      worker: false,
      encoding: 'CP1252',
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

export default function CsvUpload({ onSuccess }: CsvUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [progressText, setProgressText] = useState('Lendo arquivo...');
  const [progressPercent, setProgressPercent] = useState(0);
  const [totalFileSize, setTotalFileSize] = useState(0);
  const [bytesProcessed, setBytesProcessed] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [processedRows, setProcessedRows] = useState(0);
  const [savedRows, setSavedRows] = useState(0);
  const [failedRows, setFailedRows] = useState(0);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      alert(`O arquivo excede o limite de tamanho permitido (${MAX_FILE_SIZE_LABEL}). Tamanho do arquivo: ${formatFileSize(file.size)}`);
      return;
    }

    setStatus('uploading');
    setProgressText('Iniciando processamento...');
    setProgressPercent(0);
    setTotalFileSize(file.size);
    setBytesProcessed(0);
    setTotalRows(0);
    setProcessedRows(0);
    setSavedRows(0);
    setFailedRows(0);

    try {
      // 1. Auth
      setProgressText('Autenticando...');
      setProgressPercent(4);
      await DataService.authenticate();

      // 2. Leitura prévia do arquivo: descobre o total de registros para que o
      //    percentual reflita a quantidade importada, e não os bytes lidos.
      setProgressText('Contando registros do arquivo...');
      setProgressPercent(6);

      let totalRowsArquivo = 0;
      try {
        totalRowsArquivo = await contarRegistros(file, (linhas) => {
          setProgressText(`Contando registros... ${linhas.toLocaleString()}`);
        });
      } catch (contagemError) {
        console.error('Falha ao contar registros:', contagemError);
      }

      // 3. Processamento Chunked com PapaParse
      setTotalRows(totalRowsArquivo);
      setProgressText('Validando arquivo...');
      setProgressPercent(8);

      let totalSaved = 0;
      let totalFailed = 0;
      let cabecalhoLido = false;
      let colunas: (string | null)[] = CAMPOS_PACIENTE;
      let baseLimpa = false;
      const uploadBuffer: any[] = [];
      let lastProgressReport = 0;

      // A base antiga só é apagada depois que o início do arquivo é validado.
      const limparBaseAntiga = async () => {
        setProgressText('Limpando registros antigos...');
        const truncateResult = await DataService.truncateCollection();
        setProgressText(
          truncateResult.removedCount === -1
            ? 'Base antiga limpa de uma só vez.'
            : truncateResult.removedCount === 0
              ? 'Base antiga já estava vazia.'
              : `${truncateResult.removedCount.toLocaleString()} registros antigos removidos.`
        );
        baseLimpa = true;
      };

      const flushBatch = async (force: boolean = false) => {
        while (uploadBuffer.length >= UPLOAD_BUFFER_SIZE || (force && uploadBuffer.length > 0)) {
          const nextBatch = uploadBuffer.splice(0, force ? uploadBuffer.length : UPLOAD_BUFFER_SIZE);
          const result = await DataService.createPatientsBatch(nextBatch);
          totalSaved += result.successCount;
          totalFailed += result.failureCount;

          if (result.firstError) {
            console.error('Erro no lote:', result.firstError);
            const responseData = (result.firstError as any)?.response?.data;
            if (responseData) {
              console.error('Detalhes do erro:', JSON.stringify(responseData));
            }
          }

          const processados = totalSaved + totalFailed;
          setProcessedRows(processados);
          setSavedRows(totalSaved);
          setFailedRows(totalFailed);

          // Percentual real da importação: preparação (8%) + registros processados (91%).
          if (totalRowsArquivo > 0) {
            setProgressPercent(Math.min(99, 8 + Math.floor((processados / totalRowsArquivo) * 91)));
          }

          if (processados - lastProgressReport >= PROGRESS_REPORT_STEP || totalFailed > 0 || force) {
            lastProgressReport = processados;
            setProgressText(
              totalRowsArquivo > 0
                ? `Importando ${processados.toLocaleString()} de ${totalRowsArquivo.toLocaleString()} registros`
                : `${totalSaved.toLocaleString()} salvos • ${totalFailed} falhas`
            );
          }

          if (totalSaved === 0 && totalFailed >= MAX_FAILURES_BEFORE_ABORT) {
            throw new Error('Muitas falhas consecutivas no início do upload. Processo abortado para proteger PocketBase.');
          }
        }
      };

      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const finishWithError = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        const finishWithSuccess = async () => {
          if (settled) return;
          settled = true;

          if (totalSaved === 0) {
            reject(new Error('Nenhum registro foi salvo no PocketBase.'));
            return;
          }

          try {
            await ensureDnsResolves();
            await pb.collection('buscapac53_historico').create({
              date: new Date().toLocaleString(),
              count: totalSaved,
              fileName: file.name
            });
          } catch (hErr) {
            console.error('Erro ao salvar histórico:', hErr);
          }

          if (onSuccess) onSuccess();
          resolve();
        };

        Papa.parse(file, {
          header: false,
          skipEmptyLines: 'greedy',
          worker: false,
          encoding: 'CP1252',
          chunkSize: PARSE_CHUNK_SIZE,
          chunk: async (results, parser) => {
            parser.pause();

            try {
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

                if (!registro.NOME_DA_PESSOA_CADASTRADA && !registro.N_CNS_DA_PESSOA_CADASTRADA) {
                  continue;
                }

                uploadBuffer.push(registro);

                // Só apaga a base antiga depois de acumular registros válidos do arquivo.
                if (!baseLimpa && uploadBuffer.length >= UPLOAD_BUFFER_SIZE) {
                  await limparBaseAntiga();
                }

                if (baseLimpa && uploadBuffer.length >= UPLOAD_BUFFER_SIZE) {
                  await flushBatch();
                }
              }

              const newBytesProcessed = Math.min((results.meta as any)?.cursor || totalFileSize, totalFileSize);
              setBytesProcessed(newBytesProcessed);

              // Sem a contagem prévia (arquivo ilegível para contagem), cai para
              // o progresso baseado nos bytes já lidos.
              if (totalRowsArquivo === 0) {
                const parsePercent = totalFileSize > 0 ? newBytesProcessed / totalFileSize : 0;
                setProgressPercent(Math.min(99, 8 + Math.floor(parsePercent * 91)));
              }

              parser.resume();
            } catch (error) {
              parser.abort();
              finishWithError(error);
            }
          },
          complete: async () => {
            try {
              if (!baseLimpa) {
                if (uploadBuffer.length === 0) {
                  throw new Error('Nenhum registro válido encontrado no arquivo. A base antiga foi preservada.');
                }

                await limparBaseAntiga();
              }

              await flushBatch(true);
              await finishWithSuccess();
            } catch (error) {
              finishWithError(error);
            }
          },
          error: (error) => {
            finishWithError(error);
          }
        });
      });

      setProgressPercent(100);
      setProcessedRows(totalSaved + totalFailed);
      setSavedRows(totalSaved);
      setFailedRows(totalFailed);
      setProgressText(`Concluído! ${totalSaved.toLocaleString()} salvos • ${totalFailed} falhas`);
      setStatus('success');
      setTimeout(() => window.location.reload(), 3000);

    } catch (error) {
      console.error('Erro geral:', error);
      setStatus('error');
      setProgressText(error instanceof Error ? error.message : 'Falha no upload para PocketBase.');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 bg-white rounded-3xl border-2 border-dashed border-slate-200 transition-all hover:border-blue-400 hover:bg-blue-50/30 group/upload w-full h-full min-h-[200px]">
      <input
        type="file"
        accept=".csv"
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
            <p className="text-xs text-slate-400 mt-2 font-medium">CSV até {MAX_FILE_SIZE_LABEL}</p>
          </div>
        </button>
      )}

      {status === 'uploading' && (
        <div className="flex flex-col items-center gap-4 w-full px-4">
          <div className="relative w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-sm">
            <FileText size={28} strokeWidth={2.5} />
            <span className="absolute -bottom-2 -right-2 bg-[#001f3f] text-white text-[10px] font-black px-2 py-0.5 rounded-full tabular-nums shadow-sm">
              {progressPercent}%
            </span>
          </div>

          <div className="w-full text-center space-y-3">
            <p className="text-[11px] font-black text-blue-600 tracking-widest uppercase animate-pulse">
              {progressText}
            </p>

            <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden relative">
              <div 
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-500 ease-out relative"
                style={{ width: `${progressPercent}%` }}
              >
                <div className="absolute top-0 left-0 w-full h-full bg-white/20 animate-[shimmer_2s_infinite]" />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Enviados</p>
                <p className="text-sm font-black text-[#001f3f] tabular-nums">{savedRows.toLocaleString()}</p>
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-2 py-2">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Falhas</p>
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
              <span className="tabular-nums">{formatFileSize(bytesProcessed)} / {formatFileSize(totalFileSize || 0)}</span>
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
            <p className="text-xs text-slate-500 mt-1 font-medium">Recarregando o sistema...</p>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center gap-4 animate-in zoom-in duration-300">
          <div className="w-16 h-16 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center shadow-sm">
            <AlertCircle size={32} strokeWidth={2.5} />
          </div>
          <div className="text-center">
            <p className="text-[11px] font-black text-red-600 tracking-widest uppercase">Falha na Atualização</p>
            <p className="text-xs text-slate-500 mt-1 font-medium max-w-[200px] leading-tight">{progressText}</p>
          </div>
        </div>
      )}
    </div>
  );
}
