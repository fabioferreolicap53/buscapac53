
import React, { useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { DataService, pb } from '../services/DataService';
import Papa from 'papaparse';
import { normalizeString } from '../utils/stringUtils';

const PARSE_CHUNK_SIZE = 4 * 1024 * 1024;
const UPLOAD_BUFFER_SIZE = 480;
const PROGRESS_REPORT_STEP = 1000;
const MAX_FAILURES_BEFORE_ABORT = 20;
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_SIZE_LABEL = '1GB';

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

    try {
      // 1. Auth
      setProgressText('Autenticando...');
      setProgressPercent(10);
      await DataService.authenticate();

      // 2. Limpeza via DataService
      setProgressText('Limpando registros antigos...');
      setProgressPercent(20);
      const truncateResult = await DataService.truncateCollection();
      setProgressText(
        truncateResult.removedCount === -1
          ? 'Base antiga limpa de uma só vez.'
          : truncateResult.removedCount === 0
            ? 'Base antiga já estava vazia.'
            : `${truncateResult.removedCount.toLocaleString()} registros antigos removidos.`
      );
      setProgressPercent(22);

      // 3. Processamento Chunked com PapaParse
      let totalRead = 0;
      let totalSaved = 0;
      let totalFailed = 0;
      const uploadBuffer: any[] = [];
      let lastProgressReport = 0;
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

          const processedRows = totalSaved + totalFailed;
          if (processedRows - lastProgressReport >= PROGRESS_REPORT_STEP || totalFailed > 0 || force) {
            lastProgressReport = processedRows;
            setProgressText(`${totalSaved} salvos • ${totalFailed} falhas`);
          }

          if (totalSaved === 0 && totalFailed >= MAX_FAILURES_BEFORE_ABORT) {
            throw new Error('Muitas falhas consecutivas no início do upload. Processo abortado para proteger PocketBase.');
          }
        }
      };

      const formatDate = (dateStr: string) => {
        if (!dateStr) return '';
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
          const p = dateStr.substring(0, 10).split('-');
          return `${p[2]}/${p[1]}/${p[0]}`;
        }
        const parts = dateStr.split('/');
        if (parts.length === 3) {
          return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
        }
        return dateStr;
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
                if (totalRead === 0 && row[0]?.toLowerCase().includes('unidade')) {
                  totalRead++;
                  continue;
                }

                totalRead++;

                if (row.length < 14) continue;

                const clean = row.map((val) => {
                  const raw = (val || '').trim().replace(/^"|"$/g, '').trim();
                  return normalizeString(raw);
                });

                if (!clean[3] && !clean[4]) {
                  continue;
                }

                uploadBuffer.push({
                  NOME_UNIDADE_DE_SAUDE: clean[0],
                  NOME_EQUIPE_DE_SAUDE: clean[1],
                  CODIGO_MICROAREA: clean[2],
                  N_CNS_DA_PESSOA_CADASTRADA: clean[3],
                  NOME_DA_PESSOA_CADASTRADA: clean[4],
                  NOME_DA_MAE_PESSOA_CADASTRADA: clean[5],
                  DATA_ULTIMA_ATUALIZACAO: formatDate(clean[6]),
                  SITUACAO_USUARIO: clean[7],
                  SEXO: clean[8],
                  DATA_DE_NASCIMENTO: formatDate(clean[9]),
                  TIPO_DE_LOGRADOURO: clean[10],
                  LOGRADOURO: clean[11],
                  CEP_LOGRADOURO: clean[12],
                  BAIRRO_DE_MORADIA: clean[13],
                });

                if (uploadBuffer.length >= UPLOAD_BUFFER_SIZE) {
                  await flushBatch();
                }
              }

              const newBytesProcessed = Math.min((results.meta as any)?.cursor || totalFileSize, totalFileSize);
              setBytesProcessed(newBytesProcessed);
              const parsePercent = totalFileSize > 0 ? newBytesProcessed / totalFileSize : 0;
              const newPercent = Math.min(20 + Math.floor(parsePercent * 75), 99);
              setProgressPercent(newPercent);

              parser.resume();
            } catch (error) {
              parser.abort();
              finishWithError(error);
            }
          },
          complete: async () => {
            try {
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
      setProgressText(`Concluído! ${totalSaved} salvos • ${totalFailed} falhas`);
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
          <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-sm animate-pulse">
            <FileText size={28} strokeWidth={2.5} />
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
            <div className="flex items-center justify-between gap-3 text-xs font-bold text-slate-500">
              <span>{formatFileSize(bytesProcessed)} / {formatFileSize(totalFileSize || 0)}</span>
              <span>{progressPercent}%</span>
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
