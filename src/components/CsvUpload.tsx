
import React, { useRef } from 'react';
import { Upload, FileText, CheckCircle2 } from 'lucide-react';
import { DataService } from '../services/DataService';

export default function CsvUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = React.useState<'idle' | 'uploading' | 'success'>('idle');

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus('uploading');
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      const data = DataService.parseCSV(text);
      try {
        await DataService.saveData(data, file.name);
        setStatus('success');
      } catch (error) {
        console.error('Erro no upload:', error);
        setStatus('error');
      } finally {
        setTimeout(() => {
          setStatus('idle');
          window.location.reload();
        }, 3000);
      }
    };
    reader.readAsText(file);
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
            <p className="text-xs text-slate-500 mt-1">Clique para selecionar o arquivo</p>
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
