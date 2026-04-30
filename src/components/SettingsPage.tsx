import React from 'react';
import { Database, Clock, ArrowLeft, ShieldCheck, AlertCircle, ListOrdered, History, Info } from 'lucide-react';
import { DataService } from '../services/DataService';
import CsvUpload from './CsvUpload';

interface SettingsPageProps {
  onBack: () => void;
}

export default function SettingsPage({ onBack }: SettingsPageProps) {
  const lastUpdate = DataService.getLastUpdate();
  const dataCount = DataService.getData().length;
  const history = DataService.getHistory();

  return (
    <div className="w-full max-w-5xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button 
          onClick={onBack}
          className="flex items-center gap-2 text-slate-500 hover:text-slate-900 transition-colors font-bold text-sm group"
        >
          <ArrowLeft size={20} className="group-hover:-translate-x-1 transition-transform" />
          VOLTAR PARA BUSCA
        </button>
        <div className="flex items-center gap-3 bg-slate-100 px-4 py-2 rounded-2xl border border-slate-200">
          <ShieldCheck className="text-green-600" size={18} />
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Configurações do Sistema</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Stats and Instructions */}
        <div className="lg:col-span-2 space-y-8">
          {/* Status Card */}
          <div className="bg-gradient-to-br from-[#001f3f] to-[#003366] p-8 rounded-[2.5rem] border border-white/10 shadow-2xl relative overflow-hidden">
            <div className="absolute -top-12 -right-12 w-32 h-32 bg-white/5 rounded-full blur-2xl pointer-events-none" />
            
            <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
              <Database className="text-white/80" size={24} />
              Gestão de Dados
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="bg-white/5 p-6 rounded-2xl border border-white/5 backdrop-blur-md">
                <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em] mb-2">Total de Registros</p>
                <div className="flex items-end gap-2">
                  <p className="text-4xl font-black text-white">{dataCount.toLocaleString()}</p>
                  <p className="text-white/40 text-xs mb-1.5 font-bold">pacientes</p>
                </div>
              </div>

              <div className="bg-white/5 p-6 rounded-2xl border border-white/5 backdrop-blur-md">
                <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em] mb-2">Última Sincronização</p>
                <div className="flex items-center gap-3">
                  <Clock className="text-white/40" size={20} />
                  <p className="text-lg font-bold text-white/90">{lastUpdate || 'Nenhum dado'}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Instructions Card */}
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-xl font-bold text-slate-900 mb-6 flex items-center gap-3">
              <Info className="text-blue-600" size={22} />
              Instruções de Importação
            </h3>
            
            <div className="space-y-6">
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold shrink-0">1</div>
                <p className="text-sm text-slate-600 leading-relaxed">
                  O arquivo deve estar no formato <strong>CSV (Comma Separated Values)</strong>. Use vírgulas como delimitador.
                </p>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold shrink-0">2</div>
                <div>
                  <p className="text-sm text-slate-600 leading-relaxed mb-3">
                    As colunas devem seguir obrigatoriamente esta ordem (14 colunas):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {['Unidade', 'Equipe', 'Microárea', 'CNS', 'Nome', 'Mãe', 'Últ. Atualização', 'Situação', 'Sexo', 'Nascimento', 'Tipo Logr.', 'Logradouro', 'CEP', 'Bairro'].map((col, i) => (
                      <span key={i} className="text-[10px] bg-slate-50 border border-slate-200 px-2 py-1 rounded text-slate-500 font-medium">
                        {col}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold shrink-0">3</div>
                <p className="text-sm text-slate-600 leading-relaxed">
                  <strong>Sobrescrita:</strong> Novos uploads apagam os dados antigos. O sistema mantém apenas a base mais recente.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Upload and History */}
        <div className="space-y-8">
          {/* Upload Card */}
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-2">Novo Upload</h3>
            <p className="text-xs text-slate-500 mb-6">Arraste ou selecione o arquivo CSV.</p>
            <CsvUpload />
          </div>

          {/* History Card */}
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-6 flex items-center gap-3">
              <History className="text-slate-400" size={20} />
              Últimos Uploads
            </h3>
            
            <div className="space-y-4">
              {history.length > 0 ? (
                history.map((item, i) => (
                  <div key={i} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col gap-3 group hover:border-blue-200 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest leading-none mb-1">Competência</span>
                        <p className="text-sm font-black text-slate-800 tracking-tight">
                          {(() => {
                            const [datePart] = item.date.split(' ');
                            const [day, month, year] = datePart.split('/');
                            const months = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
                            return `${months[parseInt(month) - 1]} / ${year}`;
                          })()}
                        </p>
                      </div>
                      <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded border border-green-200 font-black tracking-widest">OK</span>
                    </div>
                    
                    <div className="h-[1px] w-full bg-slate-200/50" />

                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[10px]">
                        <p className="font-bold text-slate-500 truncate max-w-[140px]">{item.fileName}</p>
                        <p className="font-black text-[#001f3f]">{item.count.toLocaleString()} <span className="text-slate-400 font-bold">LINHAS</span></p>
                      </div>
                      <div className="flex items-center gap-2 text-[9px] text-slate-400 font-bold">
                        <Clock size={10} className="text-slate-300" />
                        SINCRO EM {item.date}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-10 text-center">
                  <p className="text-xs text-slate-300 font-bold italic">Nenhum histórico disponível</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
