
import React, { useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { DataService, pb } from '../services/DataService';
import Papa from 'papaparse';
import { normalizeString } from '../utils/stringUtils';

export default function CsvUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [progressText, setProgressText] = useState('Lendo arquivo...');
  const [progressPercent, setProgressPercent] = useState(0);
  const [totalFileSize, setTotalFileSize] = useState(0);
  const [bytesProcessed, setBytesProcessed] = useState(0);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // File size limit: 200MB
    const MAX_FILE_SIZE = 200 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      alert(`O arquivo excede o limite de tamanho permitido (200MB). Tamanho do arquivo: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
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
      await DataService.truncateCollection();

      // 3. Processamento Chunked com PapaParse
      let totalProcessed = 0;
      let chunkCount = 0;
      const chunkSize = 1024 * 1024 * 2;
      
      Papa.parse(file, {
        header: false,
        skipEmptyLines: true,
        worker: false,
        encoding: "CP1252",
        chunkSize: chunkSize,
        chunk: async (results, parser) => {
          parser.pause();
          
          const rows = results.data as string[][];
          const batch = [];

          for (const row of rows) {
            if (totalProcessed === 0 && row[0]?.toLowerCase().includes('unidade')) {
              continue;
            }

            if (row.length < 14) continue;

            const clean = row.map(val => {
              const raw = (val || '').trim().replace(/^"|"$/g, '').trim();
              return normalizeString(raw);
            });

            // Skip if name and CNS are empty (common in empty rows with delimiters)
            if (!clean[3] && !clean[4]) {
              continue;
            }

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

            const recordData: any = {
              NOME_UNIDADE_DE_SAUDE: clean[0],
              NOME_EQUIPE_DE_SAUDE: clean[1],
              CODIGO_MICROAREA: clean[2],
              N_CNS_DA_PESSOA_CADASTRADA: clean[3],
              NOME_DA_PESSOA_CADASTRADA: clean[4],
              NOME_DA_MAE_PESSOA_CADASTRADA: clean[5],
              DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO: formatDate(clean[6]),
              SITUACAO_USUARIO: clean[7],
              SEXO: clean[8],
              DATA_DE_NASCIMENTO: formatDate(clean[9]),
              TIPO_DE_LOGRADOURO: clean[10],
              LOGRADOURO: clean[11],
              CEP_LOGRADOURO: clean[12],
              BAIRRO_DE_MORADIA: clean[13],
            };

            batch.push(DataService.createPatient(recordData).catch(e => console.error('Erro na linha:', e)));
            totalProcessed++;

            if (batch.length >= 25) { // Lotes menores para a VM lenta
              await Promise.all(batch);
              batch.length = 0;
              setProgressText(`${totalProcessed} registros enviados...`);
            }
          }
          
          if (batch.length > 0) {
            await Promise.all(batch);
            setProgressText(`${totalProcessed} registros enviados...`);
          }
          
          chunkCount++;
          const newBytesProcessed = Math.min(chunkCount * chunkSize, totalFileSize);
          setBytesProcessed(newBytesProcessed);
          const newPercent = totalFileSize > 0 ? Math.min(Math.floor((newBytesProcessed / totalFileSize) * 100), 100) : 0;
          setProgressPercent(newPercent);
          
          parser.resume();
        },
        complete: async () => {
          console.log(`Upload finalizado. Total: ${totalProcessed} registros.`);
          
          // 4. Registrar histórico
          try {
            await pb.collection('buscapac53_historico').create({
              date: new Date().toLocaleString(),
              count: totalProcessed,
              fileName: file.name
            });
          } catch (hErr) {
            console.error('Erro ao salvar histórico:', hErr);
          }

          setProgressPercent(100);
          setProgressText(`Concluído! ${totalProcessed} registros processados.`);
          setStatus('success');
          setTimeout(() => window.location.reload(), 3000);
        },
        error: (error) => {
          console.error('Erro PapaParse:', error);
          setStatus('error');
          setProgressText('Erro no processamento do arquivo.');
        }
      });

    } catch (error) {
      console.error('Erro geral:', error);
      setStatus('error');
      setProgressText('Falha na conexão ou autenticação.');
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
            <p className="text-xs text-slate-400 mt-2 font-medium">CSV até 200MB</p>
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
            <p className="text-xs font-bold text-slate-500 text-right">{progressPercent}%</p>
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
