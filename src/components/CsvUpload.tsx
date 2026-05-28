
import React, { useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { DataService } from '../services/DataService';

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
    setProgressText('Lendo arquivo na memória...');
    setProgressPercent(2);
    const reader = new FileReader();
    
    // Otimização para arquivos grandes
    reader.onload = async (e) => {
      // Usando requestAnimationFrame para não travar a UI imediatamente
      requestAnimationFrame(async () => {
        const text = e.target?.result as string;
        console.log("Arquivo carregado na memória, iniciando parse...");
        setProgressText('Analisando arquivo CSV...');
        setProgressPercent(5);
        
        try {
            // Em arquivos muito grandes (150mb+), o parseCSV pode travar a thread
            // O ideal seria usar WebWorkers, mas para manter a compatibilidade
            // vamos fazer de forma síncrona, avisando que pode demorar
            const data = DataService.parseCSV(text);
            console.log(`Parse concluído: ${data.length} registros encontrados. Iniciando salvamento...`);
            setProgressText(`Processados ${data.length} registros. Preparando envio...`);
            setProgressPercent(10);
            
            await DataService.saveData(data, file.name, (statusMsg, percent) => {
              setProgressText(statusMsg);
              setProgressPercent(percent);
            });
            setStatus('success');
        } catch (error) {
            console.error('Erro no upload/processamento:', error);
            setStatus('error');
            setProgressText('Falha no upload. Verifique sua conexão e tente novamente.');
            alert("Erro ao processar o arquivo. Verifique o console para mais detalhes.");
        } finally {
            setTimeout(() => {
                setStatus('idle');
                setProgressPercent(0);
                window.location.reload();
            }, 3000);
        }
      });
    };
    
    // Mostra indicador de loading imediatamente antes do browser começar a ler o arquivo pesadão
    setTimeout(() => {
        reader.readAsText(file);
    }, 100);
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
