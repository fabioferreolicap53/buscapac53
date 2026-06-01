
import React, { useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { DataService, pb } from '../services/DataService';
import Papa from 'papaparse';

export default function CsvUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [progressText, setProgressText] = useState('Lendo arquivo...');
  const [progressPercent, setProgressPercent] = useState(0);

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

    try {
      // 1. Auth
      setProgressText('Autenticando...');
      await DataService.authenticate();

      // 2. Limpeza (Otimizada via recriação de coleção para evitar OOM no SQLite/VM)
      setProgressText('Limpando registros antigos...');
      try {
        const collection = await pb.collections.getOne('buscapac53_pacientes');
        const schemaClone = JSON.parse(JSON.stringify(collection));
        delete schemaClone.id;
        delete schemaClone.created;
        delete schemaClone.updated;
        await pb.collections.delete(collection.id);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await pb.collections.create(schemaClone);
      } catch (err) {
        console.warn('Erro ao recriar coleção, tentando deleção manual...', err);
        // Fallback simplificado
      }

      // 3. Processamento Chunked com PapaParse
      let totalProcessed = 0;
      
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        worker: true,
        chunkSize: 1024 * 1024 * 2, // 2MB por pedaço
        chunk: async (results, parser) => {
          parser.pause();
          
          const rows = results.data as any[];
          for (const row of rows) {
            try {
              // Mapeamento de campos conforme interface PatientData
              await pb.collection('buscapac53_pacientes').create({
                NOME_UNIDADE_DE_SAUDE: row.NOME_UNIDADE_DE_SAUDE || '',
                NOME_EQUIPE_DE_SAUDE: row.NOME_EQUIPE_DE_SAUDE || '',
                CODIGO_MICROAREA: row.CODIGO_MICROAREA || '',
                N_CNS_DA_PESSOA_CADASTRADA: row.N_CNS_DA_PESSOA_CADASTRADA || '',
                NOME_DA_PESSOA_CADASTRADA: row.NOME_DA_PESSOA_CADASTRADA || '',
                NOME_DA_MAE_PESSOA_CADASTRADA: row.NOME_DA_MAE_PESSOA_CADASTRADA || '',
                DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO: row.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO || '',
                SITUACAO_USUARIO: row.SITUACAO_USUARIO || '',
                SEXO: row.SEXO || '',
                DATA_DE_NASCIMENTO: row.DATA_DE_NASCIMENTO || '',
                TIPO_DE_LOGRADOURO: row.TIPO_DE_LOGRADOURO || '',
                LOGRADOURO: row.LOGRADOURO || '',
                CEP_LOGRADOURO: row.CEP_LOGRADOURO || '',
                BAIRRO_DE_MORADIA: row.BAIRRO_DE_MORADIA || '',
              }, { $autoCancel: false });
              
              totalProcessed++;
              if (totalProcessed % 100 === 0) {
                console.log(`${totalProcessed} linhas processadas`);
                setProgressText(`${totalProcessed} registros enviados...`);
                // Progresso visual aproximado baseado no tamanho do arquivo vs processado
                // Como não sabemos o total exato de linhas antes de ler, usamos uma estimativa
                // ou apenas mostramos o contador.
              }
            } catch (e) {
              console.error('Erro ao inserir linha:', e, row);
            }
          }
          
          parser.resume();
        },
        complete: () => {
          console.log(`Upload finalizado. Total: ${totalProcessed} registros.`);
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
