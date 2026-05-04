import { User, IdCard, UserSearch, ArrowRight, MapPin, Calendar, Heart, Shield, Clock, X, Sparkles, Search, Users, Activity } from 'lucide-react';
import { useState } from 'react';
import { DataService, PatientData } from '../services/DataService';
import { normalizeString } from '../utils/stringUtils';

export default function SearchModule() {
  const [activeTab, setActiveTab] = useState<'name' | 'cns'>('name');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientData[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  const getPatientKey = (patient: PatientData) => {
    return patient.id || patient.N_CNS_DA_PESSOA_CADASTRADA || `${patient.NOME_DA_PESSOA_CADASTRADA}-${patient.DATA_DE_NASCIMENTO}`;
  };

  const mergePatients = (...groups: PatientData[][]) => {
    const merged = new Map<string, PatientData>();

    groups.flat().forEach((patient) => {
      merged.set(getPatientKey(patient), patient);
    });

    return Array.from(merged.values());
  };

  const sortPatients = (patients: PatientData[], searchTerm?: string) => {
    const normalizedSearch = searchTerm ? normalizeString(searchTerm) : '';

    return [...patients].sort((a, b) => {
      // Se houver termo de busca, prioriza quem começa com o termo exato ou tem o nome igual
      if (normalizedSearch) {
        const nameA = normalizeString(a.NOME_DA_PESSOA_CADASTRADA);
        const nameB = normalizeString(b.NOME_DA_PESSOA_CADASTRADA);
        
        const exactA = nameA === normalizedSearch;
        const exactB = nameB === normalizedSearch;
        if (exactA && !exactB) return -1;
        if (!exactA && exactB) return 1;

        const startsA = nameA.startsWith(normalizedSearch);
        const startsB = nameB.startsWith(normalizedSearch);
        if (startsA && !startsB) return -1;
        if (!startsA && startsB) return 1;
      }

      const maeA = normalizeString(a.NOME_DA_MAE_PESSOA_CADASTRADA);
      const maeB = normalizeString(b.NOME_DA_MAE_PESSOA_CADASTRADA);

      if (maeA !== maeB) {
        return maeA.localeCompare(maeB);
      }

      const formatSortDate = (d: string) => {
        if (!d || !d.includes('/')) return '00000000';
        const parts = d.split('/');
        if (parts.length !== 3) return '00000000';
        return parts[2] + parts[1] + parts[0];
      };

      const dateA = formatSortDate(a.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO);
      const dateB = formatSortDate(b.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO);

      return dateB.localeCompare(dateA);
    });
  };

  const filterPatientsByQuery = (patients: PatientData[], searchTerm: string, searchType: 'name' | 'cns') => {
    const normalizedSearch = normalizeString(searchTerm);

    if (searchType === 'cns') {
      return patients.filter(patient => patient.N_CNS_DA_PESSOA_CADASTRADA.includes(searchTerm.trim()));
    }

    // Busca inteligente por tokens
    const tokens = normalizedSearch.split(' ').filter(t => t.length > 0);
    return patients.filter((patient) => {
      const patientName = normalizeString(patient.NOME_DA_PESSOA_CADASTRADA);
      const nameParts = patientName.split(' ');
      
      return tokens.every((token, index) => {
        // O último token digitado pode ser apenas o começo da palavra (ex: "ferr" acha "ferreira")
        if (index === tokens.length - 1) {
          return nameParts.some(part => part.startsWith(token));
        }
        // Tokens anteriores precisam ser a palavra exata (ex: "fabio" acha "fabio", não acha "fabiola")
        return nameParts.includes(token);
      });
    });
  };

  const handleSearch = async () => {
    const searchTerm = query.trim();
    if (!searchTerm) return;
    
    setLoading(true);
    try {
      const localData = DataService.getData();
      const localResults = filterPatientsByQuery(localData, searchTerm, activeTab);
      setResults(sortPatients(localResults, searchTerm));
      setHasSearched(true);

      // Sempre busca remoto para garantir dados mais atualizados e mescla
      const remoteResults = await DataService.searchRemote(searchTerm, activeTab);
      if (remoteResults && remoteResults.length > 0) {
        const finalResults = mergePatients(localResults, remoteResults);
        setResults(sortPatients(finalResults, searchTerm));
      }
    } catch (error) {
      console.error('Erro na busca:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusStyles = (status: string) => {
    const s = normalizeString(status || '');
    if (s.includes('ativo') || s.includes('cadastrado') || s.includes('residente')) {
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 shadow-[0_0_15px_-3px_rgba(16,185,129,0.3)]';
    }
    if (s.includes('obito') || s.includes('falecido')) {
      return 'bg-slate-50 text-slate-700 border-slate-200 shadow-[0_0_15px_-3px_rgba(71,85,105,0.3)]';
    }
    if (s.includes('mudanca') || s.includes('mudou') || s.includes('domicilio')) {
      return 'bg-blue-50 text-blue-700 border-blue-200 shadow-[0_0_15px_-3px_rgba(59,130,246,0.3)]';
    }
    if (s.includes('suspenso') || s.includes('inativo') || s.includes('desativado')) {
      return 'bg-amber-50 text-amber-700 border-amber-200 shadow-[0_0_15px_-3px_rgba(245,158,11,0.3)]';
    }
    return 'bg-slate-50 text-slate-600 border-slate-200 shadow-sm';
  };

  return (
    <div className="w-full max-w-3xl flex flex-col gap-8">
      <div className={`w-full bg-white rounded-[1.8rem] shadow-[0_20px_50px_-15px_rgba(0,31,63,0.1)] border border-slate-200/60 overflow-hidden relative group/container transition-all duration-500 ${loading ? 'opacity-70 pointer-events-none' : ''}`}>
        {/* Luminous Background Effects */}
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-blue-500/20 to-transparent opacity-0 group-hover/container:opacity-100 transition-opacity duration-1000" />
        <div className="absolute -top-24 -left-24 w-64 h-64 bg-blue-50/50 rounded-full blur-3xl pointer-events-none" />
        
        {/* Tabs/Toggle */}
        <div className="flex bg-slate-50/50 p-1 gap-1 mt-6 mx-8 rounded-2xl border border-slate-100/80 backdrop-blur-sm">
          <button
            onClick={() => setActiveTab('name')}
            disabled={loading}
            className={`flex-1 py-3 px-4 text-[10px] font-black flex items-center justify-center gap-2 rounded-xl transition-all duration-500 relative tracking-widest ${
              activeTab === 'name'
                ? 'text-white bg-[#001f3f] shadow-md'
                : 'text-slate-400 hover:text-slate-600 hover:bg-white/80'
            }`}
          >
            <User size={14} strokeWidth={2.5} />
            NOME DO PACIENTE
          </button>
          <button
            onClick={() => setActiveTab('cns')}
            disabled={loading}
            className={`flex-1 py-3 px-4 text-[10px] font-black flex items-center justify-center gap-2 rounded-xl transition-all duration-500 relative tracking-widest ${
              activeTab === 'cns'
                ? 'text-white bg-[#001f3f] shadow-md'
                : 'text-slate-400 hover:text-slate-600 hover:bg-white/80'
            }`}
          >
            <IdCard size={14} strokeWidth={2.5} />
            NÚMERO DO CNS
          </button>
        </div>

        {/* Search Input Area */}
        <div className="px-4 sm:px-8 pb-8 sm:pb-10 pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1 group/input">
              <div className="absolute left-4 sm:left-6 top-1/2 -translate-y-1/2">
                {loading ? (
                  <div className="w-5 h-5 border-2 border-[#001f3f]/20 border-t-[#001f3f] rounded-full animate-spin" />
                ) : (
                  <Search className="text-slate-400 group-focus-within/input:text-blue-500 transition-colors" size={20} />
                )}
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                disabled={loading}
                className="w-full pl-12 sm:pl-14 pr-10 sm:pr-12 py-4 sm:py-5 bg-white border-2 border-slate-200 focus:border-blue-500 rounded-xl sm:rounded-2xl font-manrope text-sm sm:text-base text-slate-800 outline-none transition-all placeholder:text-slate-400 disabled:cursor-not-allowed shadow-sm focus:shadow-md focus:shadow-blue-500/10"
                spellCheck="false"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                placeholder={
                  activeTab === 'name'
                    ? 'Quem deseja localizar?'
                    : 'Digite os 15 números...'
                }
                type="text"
              />
              {query && !loading && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 p-1.5 rounded-full hover:bg-red-50 text-slate-200 hover:text-red-400 transition-colors"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            <button 
              onClick={handleSearch}
              disabled={loading}
              className="w-full sm:w-auto bg-[#001f3f] text-white px-8 py-4 sm:py-5 rounded-xl sm:rounded-2xl font-manrope text-[11px] font-black tracking-widest flex items-center justify-center gap-3 shadow-lg shadow-blue-900/10 hover:scale-[1.02] transition-all active:scale-95 group/btn overflow-hidden whitespace-nowrap disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  BUSCANDO...
                </>
              ) : (
                <>
                  BUSCAR
                  <ArrowRight className="group-hover/btn:translate-x-1 transition-transform" size={16} strokeWidth={3} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>



      {/* Results Section */}
      {hasSearched && (
        <div className={`flex flex-col gap-6 sm:gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700 ${loading ? 'opacity-50 blur-[2px]' : ''}`}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between px-2 sm:px-4 gap-4">
            <h2 className="text-xs sm:text-sm font-black text-slate-400 flex items-center gap-3 tracking-[0.2em] uppercase">
              <Shield className="text-[#001f3f]/20" size={20} />
              Resultados
            </h2>
            <span className="bg-[#001f3f]/5 text-[#001f3f] px-4 py-1.5 rounded-full text-[10px] sm:text-[11px] font-black border border-[#001f3f]/5 tracking-widest text-center sm:text-left">
              {results.length} ENCONTRADOS
            </span>
          </div>
          
          {results.length > 0 ? (
            <div className="grid grid-cols-1 gap-6">
              {results.map((patient, idx) => (
                <div key={idx} className="bg-white p-5 sm:p-8 rounded-[1.5rem] sm:rounded-[1.8rem] border border-slate-200 shadow-[0_10px_40px_-15px_rgba(0,0,0,0.05)] hover:shadow-[0_30px_60px_-20px_rgba(0,31,63,0.15)] hover:border-blue-100 transition-all duration-500 relative group/card overflow-hidden hover:-translate-y-1">
                  {/* Subtle Background Glow */}
                  <div className="absolute -right-20 -top-20 w-64 h-64 bg-blue-50/30 rounded-full blur-3xl opacity-0 group-hover/card:opacity-100 transition-opacity duration-1000 pointer-events-none" />
                  
                  <div className="absolute top-0 left-0 w-1.5 h-full bg-gradient-to-b from-blue-400 to-[#001f3f] opacity-0 group-hover/card:opacity-100 transition-opacity duration-500" />
                  
                  <div className="flex flex-col gap-5 sm:gap-6 relative z-10">
                      <div className="flex items-center gap-3 sm:gap-4 overflow-hidden">
                        <span className={`shrink-0 px-2.5 py-1 text-[8px] sm:text-[9px] font-black rounded-lg uppercase tracking-widest border transition-all duration-500 hover:scale-105 ${getStatusStyles(patient.SITUACAO_USUARIO)}`}>
                          {patient.SITUACAO_USUARIO}
                        </span>
                        <h3 className="text-lg sm:text-xl font-black text-slate-900 tracking-tight break-words">{patient.NOME_DA_PESSOA_CADASTRADA}</h3>
                      </div>
                      <div className="flex items-center gap-3 sm:pl-4 sm:border-l border-slate-200">
                        <div className="flex flex-col items-start sm:items-end w-full sm:w-auto">
                          <span className="text-[6px] sm:text-[7px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none mb-1">CARTÃO NACIONAL</span>
                          <div className="flex items-center gap-2">
                            <div className="w-5 h-5 rounded bg-blue-50 flex items-center justify-center border border-blue-100">
                              <IdCard size={12} className="text-blue-600" />
                            </div>
                            <span className="text-[10px] sm:text-[11px] font-black text-slate-700 tracking-widest tabular-nums leading-none">{patient.N_CNS_DA_PESSOA_CADASTRADA}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-start">
                      {/* Details Column (7/12) */}
                      <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 sm:gap-y-4">
                        <div className="flex items-center gap-3 p-1.5 sm:p-2 rounded-xl border border-transparent hover:border-slate-100 hover:bg-slate-50/50 transition-all group/item">
                          <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-100">
                            <Heart size={14} className="sm:size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-slate-500">Mãe</p>
                            <p className={`text-[11px] sm:text-xs font-black uppercase break-words leading-tight ${patient.NOME_DA_MAE_PESSOA_CADASTRADA ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.NOME_DA_MAE_PESSOA_CADASTRADA || '—'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-1.5 sm:p-2 rounded-xl border border-transparent hover:border-slate-100 hover:bg-slate-50/50 transition-all group/item">
                          <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600 border border-indigo-100">
                            <Calendar size={14} className="sm:size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-slate-500">Nascimento</p>
                            <p className={`text-[11px] sm:text-xs font-black leading-tight ${patient.DATA_DE_NASCIMENTO ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.DATA_DE_NASCIMENTO ? `${patient.DATA_DE_NASCIMENTO} (${patient.SEXO || '?'})` : '—'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-1.5 sm:p-2 rounded-xl border border-transparent hover:border-slate-100 hover:bg-slate-50/50 transition-all group/item">
                          <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600 border border-amber-100">
                            <Clock size={14} className="sm:size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-slate-500">ÚLTIMA ATUALIZAÇÃO</p>
                            <p className={`text-[11px] sm:text-xs font-black leading-tight ${patient.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO || '—'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 p-1.5 sm:p-2 rounded-xl border border-transparent hover:border-slate-100 hover:bg-slate-50/50 transition-all group/item">
                          <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 border border-emerald-100">
                            <MapPin size={14} className="sm:size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-slate-500">Endereço</p>
                            <p className={`text-[11px] sm:text-xs font-black uppercase break-words leading-tight ${patient.LOGRADOURO ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.LOGRADOURO ? (
                                <>
                                  {patient.TIPO_DE_LOGRADOURO} {patient.LOGRADOURO}, {patient.BAIRRO_DE_MORADIA}
                                  {patient.CEP_LOGRADOURO && <span className="ml-1 text-slate-500 font-bold">• {patient.CEP_LOGRADOURO}</span>}
                                </>
                              ) : '—'}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Info Box (5/12) */}
                      <div className="lg:col-span-5 relative group/info h-full">
                        <div className="absolute -top-4 -right-4 w-24 h-24 bg-blue-400/10 rounded-full blur-2xl opacity-0 group-hover/info:opacity-100 transition-opacity duration-700 hidden sm:block" />
                        <div className="absolute -bottom-4 -left-4 w-24 h-24 bg-indigo-400/10 rounded-full blur-2xl opacity-0 group-hover/info:opacity-100 transition-opacity duration-700 hidden sm:block" />
                        
                        <div className="relative h-full bg-slate-100/50 rounded-2xl p-4 sm:p-5 border border-slate-200 shadow-sm flex flex-col justify-between overflow-hidden group-hover/info:border-blue-300 transition-colors duration-500">
                          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-blue-500/20 to-transparent opacity-0 group-hover/info:opacity-100 transition-opacity duration-700" />
                          
                          <div className="flex items-start gap-4 mb-4">
                            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-[#001f3f] flex items-center justify-center text-white shadow-sm transition-all duration-500 shrink-0">
                              <Activity size={14} className="sm:size-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[7px] font-black uppercase tracking-[0.2em] text-slate-400 mb-0.5">Unidade de Saúde</p>
                              <p className={`text-[11px] sm:text-xs font-black uppercase leading-tight tracking-tight ${patient.NOME_UNIDADE_DE_SAUDE ? 'text-[#001f3f]' : 'text-slate-300'}`}>
                                {patient.NOME_UNIDADE_DE_SAUDE || '—'}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-col sm:flex-row sm:items-center justify-between pt-4 border-t border-slate-200/60 gap-4">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-7 h-7 rounded-md bg-slate-200/50 flex items-center justify-center shrink-0">
                                <Users size={12} className="text-slate-500" />
                              </div>
                              <div className="min-w-0">
                                <p className="text-[7px] font-black text-slate-400 uppercase tracking-widest leading-none mb-0.5">Equipe</p>
                                <p className={`text-[10px] font-black truncate uppercase tracking-tight ${patient.NOME_EQUIPE_DE_SAUDE && patient.NOME_EQUIPE_DE_SAUDE !== 'SEM EQUIPE' ? 'text-slate-600' : 'text-slate-300'}`}>
                                  {patient.NOME_EQUIPE_DE_SAUDE && patient.NOME_EQUIPE_DE_SAUDE !== 'SEM EQUIPE' ? patient.NOME_EQUIPE_DE_SAUDE : '—'}
                                </p>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2 bg-slate-200/50 pl-1.5 pr-2.5 py-1 rounded-lg border border-slate-200/60 shrink-0 self-start sm:self-auto">
                              <div className="w-6 h-6 rounded bg-white flex items-center justify-center shadow-sm">
                                <MapPin size={10} className="text-slate-400" />
                              </div>
                              <div className="flex flex-col items-start">
                                <span className="text-[6px] font-black text-slate-400 uppercase tracking-tighter leading-none">MA</span>
                                <div className="flex items-center gap-1">
                                  <span className={`text-[10px] font-black tabular-nums leading-none ${patient.CODIGO_MICROAREA ? 'text-slate-700' : 'text-slate-300'}`}>
                                    {patient.CODIGO_MICROAREA || '—'}
                                  </span>
                                  <div className={`w-1 h-1 rounded-full ${patient.CODIGO_MICROAREA ? 'bg-emerald-500' : 'bg-slate-200'}`} />
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-slate-50/50 p-12 sm:p-20 rounded-[2rem] sm:rounded-[3rem] border-2 border-dashed border-slate-100 text-center">
              <p className="text-slate-300 font-black text-[10px] sm:text-xs uppercase tracking-[0.3em]">Nenhum registro localizado</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
