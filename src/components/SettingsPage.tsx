import React, { useEffect, useState } from 'react';
import { Database, Clock, ArrowLeft, ShieldCheck, History, Info, CalendarDays } from 'lucide-react';
import { DataService, UploadHistory, formatCompetencia } from '../services/DataService';
import CsvUpload from './CsvUpload';
import DeleteDatabase from './DeleteDatabase';

interface SettingsPageProps {
  onBack: () => void;
}

export default function SettingsPage({ onBack }: SettingsPageProps) {
  const [lastUpdate, setLastUpdate] = useState<string | null>(DataService.getLastUpdate());
  const [dataCount, setDataCount] = useState<number>(DataService.getTotalCount());
  const [history, setHistory] = useState<UploadHistory[]>(DataService.getHistory());
  const [loading, setLoading] = useState(true);

  // Competência da base importada (AAAA-MM, formato do input month).
  const [competencia, setCompetencia] = useState<string | null>(DataService.getCompetencia());
  const [competenciaInput, setCompetenciaInput] = useState('');
  const [savingCompetencia, setSavingCompetencia] = useState(false);
  const [competenciaFeedback, setCompetenciaFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const syncData = async () => {
    setLoading(true);
    const result = await DataService.syncFromRemote();
    if (result) {
      setLastUpdate(result.lastUpdate);
      setDataCount(result.totalCount);
      setHistory(result.history);

      const value = result.competencia?.value ?? null;
      setCompetencia(value);
      // Só preenche o campo no primeiro carregamento (não sobrescreve o que o usuário digitou).
      setCompetenciaInput(prev => prev || value || '');
    }
    setLoading(false);
  };

  useEffect(() => {
    syncData();
  }, []);

  const handleSaveCompetencia = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!competenciaInput) {
      setCompetenciaFeedback({ ok: false, text: 'Selecione o mês e o ano da competência.' });
      return;
    }

    setSavingCompetencia(true);
    setCompetenciaFeedback(null);

    try {
      const saved = await DataService.saveCompetencia(competenciaInput);
      setCompetencia(saved.value);
      setCompetenciaFeedback({
        ok: true,
        text: `Competência ${formatCompetencia(saved.value)} salva para todos os usuários.`
      });
    } catch (error) {
      setCompetenciaFeedback({
        ok: false,
        text: error instanceof Error ? error.message : 'Falha ao salvar a competência.'
      });
    } finally {
      setSavingCompetencia(false);
    }
  };

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
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

      {/* Painel de status em largura total: os três indicadores dividem o espaço igualmente */}
      <div className="bg-gradient-to-br from-[#001f3f] to-[#003366] p-8 rounded-[2.5rem] border border-white/10 shadow-2xl relative overflow-hidden">
        <div className="absolute -top-12 -right-12 w-32 h-32 bg-white/5 rounded-full blur-2xl pointer-events-none" />

        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
          <Database className="text-white/80" size={24} />
          Gestão de Dados
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div className="bg-white/5 p-6 rounded-2xl border border-white/5 backdrop-blur-md flex flex-col justify-between gap-5 min-h-[120px]">
            <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Total de Registros</p>
            <div className="flex items-end gap-2">
              <p className="text-4xl font-black text-white leading-none">
                {loading ? '...' : dataCount.toLocaleString()}
              </p>
              <p className="text-white/40 text-xs mb-1 font-bold">pacientes</p>
            </div>
          </div>

          <div className="bg-white/5 p-6 rounded-2xl border border-white/5 backdrop-blur-md flex flex-col justify-between gap-5 min-h-[120px]">
            <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Última Sincronização</p>
            <div className="flex items-center gap-3">
              <Clock className="text-white/40 shrink-0" size={20} />
              <p className="text-lg font-bold text-white/90 leading-tight">
                {loading ? 'Sincronizando...' : (lastUpdate || 'Nenhum dado')}
              </p>
            </div>
          </div>

          <div className="bg-white/5 p-6 rounded-2xl border border-white/5 backdrop-blur-md flex flex-col justify-between gap-5 min-h-[120px]">
            <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em]">Competência da Base</p>
            <div className="flex items-center gap-3">
              <CalendarDays className="text-white/40 shrink-0" size={20} />
              {loading ? (
                <p className="text-base font-bold text-white/60">Carregando...</p>
              ) : formatCompetencia(competencia) ? (
                <p className="text-3xl font-black text-white leading-none tracking-tight">
                  {formatCompetencia(competencia)}
                </p>
              ) : (
                <p className="text-sm font-bold text-white/40 italic">Não informada</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Duas colunas equilibradas em altura: ações à esquerda, referência e risco à direita */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Coluna esquerda: operações do dia a dia */}
        <div className="space-y-6">
          {/* Upload Card */}
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-2">Novo Upload</h3>
            <p className="text-xs text-slate-500 mb-6">Arraste ou selecione o arquivo CSV.</p>
            <CsvUpload onSuccess={syncData} />
          </div>

          {/* Competência Card */}
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-2 flex items-center gap-3">
              <CalendarDays className="text-blue-600" size={20} />
              Competência da Base
            </h3>
            <p className="text-xs text-slate-500 mb-6 leading-relaxed">
              Mês e ano dos dados importados. Aparece na tela de busca para todos os usuários.
            </p>

            <form onSubmit={handleSaveCompetencia} className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <label htmlFor="competencia" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">
                    Mês / Ano
                  </label>
                  <input
                    id="competencia"
                    type="month"
                    value={competenciaInput}
                    onChange={(event) => {
                      setCompetenciaInput(event.target.value);
                      setCompetenciaFeedback(null);
                    }}
                    className="w-full px-4 py-3 rounded-2xl border border-slate-200 bg-slate-50 text-sm font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 transition-all"
                  />
                </div>
                <button
                  type="submit"
                  disabled={savingCompetencia}
                  className="px-6 py-3 rounded-2xl bg-[#001f3f] text-white text-xs font-black uppercase tracking-widest hover:bg-[#003366] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {savingCompetencia ? 'Salvando...' : 'Salvar'}
                </button>
              </div>

              {competenciaFeedback ? (
                <p className={`text-xs font-bold ${competenciaFeedback.ok ? 'text-green-600' : 'text-red-600'}`}>
                  {competenciaFeedback.text}
                </p>
              ) : (
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                  Atual: <span className="text-[#001f3f]">{formatCompetencia(competencia) ?? 'não informada'}</span>
                </p>
              )}
            </form>
          </div>

          {/* History Card */}
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-6 flex items-center gap-3">
              <History className="text-slate-400" size={20} />
              Últimos Uploads
            </h3>

            <div className="space-y-4">
              {loading ? (
                <div className="py-10 text-center">
                  <p className="text-xs text-slate-400 animate-pulse font-bold">Buscando histórico...</p>
                </div>
              ) : history.length > 0 ? (
                history.slice(0, 3).map((item, i) => (
                  <div key={i} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col gap-3 group hover:border-blue-200 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-[8px] font-black text-blue-500 uppercase tracking-widest leading-none mb-1">Mês do Upload</span>
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

        {/* Coluna direita: referência e zona de risco */}
        <div className="space-y-6">
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
                    As colunas devem seguir obrigatoriamente esta ordem (15 colunas):
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {['Unidade', 'Equipe', 'Microárea', 'CNS', 'Nome', 'Mãe', 'Últ. Atualização', 'Situação', 'Sexo', 'Nascimento', 'Tipo Logr.', 'Logradouro', 'CEP', 'Bairro', 'CPF'].map((col, i) => (
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

          {/* Delete Card */}
          <DeleteDatabase onSuccess={syncData} />
        </div>
      </div>
    </div>
  );
}
