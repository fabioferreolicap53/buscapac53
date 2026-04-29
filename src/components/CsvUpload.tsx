
import React, { useRef } from 'react';
import { Upload, FileText, CheckCircle2 } from 'lucide-react';
import { DataService } from '../services/DataService';

export default function CsvUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = React.useState<'idle' | 'uploading' | 'success' | 'error'>('idle');

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
    const reader = new FileReader();
    
    // Otimização para arquivos grandes
    reader.onload = async (e) => {
      // Usando requestAnimationFrame para não travar a UI imediatamente
      requestAnimationFrame(async () => {
        const text = e.target?.result as string;
        console.log("Arquivo carregado na memória, iniciando parse...");
        
        try {
            // Em arquivos muito grandes (150mb+), o parseCSV pode travar a thread
            // O ideal seria usar WebWorkers, mas para manter a compatibilidade
            // vamos fazer de forma síncrona, avisando que pode demorar
            const data = DataService.parseCSV(text);
            console.log(`Parse concluído: ${data.length} registros encontrados. Iniciando salvamento...`);
            
            await DataService.saveData(data, file.name);
            setStatus('success');
        } catch (error) {
            console.error('Erro no upload/processamento:', error);
            setStatus('error');
            alert("Erro ao processar o arquivo. Verifique o console para mais detalhes.");
        } finally {
            setTimeout(() => {
                setStatus('idle');
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
    <div className="flex flex-col items-center p-6 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 transition-all hover:border-primary/50">
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
          className="flex flex-col items-center gap-3 group"
        >
          <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-full flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform">
            <Upload className="text-primary" size={24} />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Upload Base de Dados (CSV)</p>
            <p className="text-xs text-slate-500 mt-1">Clique para selecionar o arquivo (Máx: 200MB)</p>
          </div>
        </button>
      )}

      {status === 'uploading' && (
        <div className="flex flex-col items-center gap-3 animate-pulse">
          <FileText className="text-primary" size={32} />
          <p className="text-sm font-semibold text-primary">Processando arquivo...</p>
        </div>
      )}

      {status === 'success' && (
        <div className="flex flex-col items-center gap-3">
          <CheckCircle2 className="text-green-500" size={32} />
          <p className="text-sm font-semibold text-green-600">Base atualizada!</p>
        </div>
      )}
    </div>
  );
}
