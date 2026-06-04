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

  return (
    <div className="w-full max-w-4xl mx-auto px-2 sm:px-0">
      {/* Tabs / Search Header */}
      <div className="flex flex-col sm:flex-row items-center justify-between mb-6 sm:mb-8 gap-4">
        <div className="flex bg-slate-100 p-1 rounded-2xl w-full sm:w-auto">
          <button
            onClick={() => setActiveTab('name')}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-xs font-black tracking-widest transition-all duration-300 ${
              activeTab === 'name' 
                ? 'bg-white text-blue-600 shadow-sm ring-1 ring-slate-200' 
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <User size={14} strokeWidth={3} />
            NOME
          </button>
          <button
            onClick={() => setActiveTab('cns')}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-xs font-black tracking-widest transition-all duration-300 ${
              activeTab === 'cns' 
                ? 'bg-white text-blue-600 shadow-sm ring-1 ring-slate-200' 
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <IdCard size={14} strokeWidth={3} />
            CNS
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative group mb-10 sm:mb-16">
        <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-[2rem] blur opacity-10 group-hover:opacity-20 transition duration-1000 group-focus-within:opacity-30" />
        <div className="relative flex flex-col sm:flex-row items-center gap-3 bg-white p-2.5 sm:p-3 rounded-[1.8rem] border border-slate-200 shadow-xl shadow-blue-900/5">
          <div className="flex-1 flex items-center gap-3 sm:gap-4 px-3 sm:px-5 w-full">
            <Search className="text-slate-400 shrink-0" size={20} strokeWidth={2.5} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={activeTab === 'name' ? "DIGITE O NOME DO PACIENTE..." : "DIGITE O NÚMERO DO CNS..."}
              className="w-full bg-transparent border-none focus:ring-0 focus:outline-none outline-none text-slate-800 placeholder:text-slate-300 font-black text-sm sm:text-base tracking-tight uppercase"
            />
            {query && (
              <button 
                onClick={() => setQuery('')}
                className="p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors shrink-0"
              >
                <X size={16} strokeWidth={3} />
              </button>
            )}
          </div>
          
          <button
            onClick={handleSearch}
            disabled={loading || !query.trim()}
            className="w-full sm:w-auto flex items-center justify-center gap-3 px-8 py-3.5 sm:py-4 bg-[#001f3f] hover:bg-[#003366] disabled:bg-slate-200 text-white rounded-2xl font-black text-xs sm:text-sm tracking-[0.2em] transition-all duration-300 shadow-lg shadow-blue-900/20 active:scale-95 group/btn"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                BUSCAR
                <ArrowRight className="group-hover/btn:translate-x-1 transition-transform" size={16} strokeWidth={3} />
              </>
            )}
          </button>
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
                <div 
                  key={getPatientKey(patient)} 
                  className="bg-white rounded-[2rem] border border-slate-200 shadow-sm hover:shadow-xl hover:border-blue-200 transition-all duration-500 overflow-hidden group/card flex flex-col"
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  {/* Top Bar Status & Location */}
                  <div className="relative px-6 sm:px-8 py-5 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/30">
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-[10px] font-black text-emerald-700 tracking-widest uppercase">{patient.SITUACAO_USUARIO || 'Ativo'}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                      {/* Unidade Badge - Destaque Máximo */}
                      <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-2xl shadow-sm border border-blue-100 group/unit hover:border-blue-300 transition-colors">
                        <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200">
                          <MapPin size={16} strokeWidth={2.5} />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest leading-none mb-1">Unidade de Saúde</span>
                          <span className="text-sm sm:text-base font-black text-blue-900 uppercase tracking-tight leading-none">{patient.NOME_UNIDADE_DE_SAUDE}</span>
                        </div>
                      </div>

                      {/* Equipe/Micro Badge - Glass Style */}
                      <div className="flex items-center gap-3 bg-emerald-500/10 backdrop-blur-sm px-4 py-2 rounded-2xl border border-emerald-500/20 group/team hover:bg-emerald-500/20 transition-colors">
                        <div className="w-8 h-8 rounded-xl bg-emerald-500 flex items-center justify-center text-white shadow-lg shadow-emerald-200">
                          <Activity size={16} strokeWidth={2.5} />
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex flex-col">
                            <span className="text-[8px] font-black text-emerald-600/60 uppercase tracking-widest leading-none mb-1">Equipe</span>
                            <span className="text-sm font-black text-emerald-900 uppercase tracking-tight leading-none">{patient.NOME_EQUIPE_DE_SAUDE}</span>
                          </div>
                          <div className="w-px h-6 bg-emerald-500/20" />
                          <div className="flex flex-col">
                            <span className="text-[8px] font-black text-emerald-600/60 uppercase tracking-widest leading-none mb-1">Micro</span>
                            <span className="text-sm font-black text-blue-600 uppercase tracking-tight leading-none">{patient.CODIGO_MICROAREA}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="p-6 sm:p-8 flex-1">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-6 mb-8">
                      <div className="flex items-start gap-5">
                        <div className="w-14 h-14 sm:w-16 sm:h-16 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-[1.2rem] flex items-center justify-center text-white shadow-lg shadow-blue-200 group-hover/card:scale-105 transition-transform duration-500 shrink-0">
                          <User size={28} sm:size={32} strokeWidth={2} />
                        </div>
                        <div className="min-w-0 pt-1">
                          <span className="text-[10px] font-black text-blue-600 uppercase tracking-[0.2em] mb-1.5 block">Paciente</span>
                          <h3 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight leading-none uppercase truncate">
                            {patient.NOME_DA_PESSOA_CADASTRADA}
                          </h3>
                        </div>
                      </div>

                      <div className="flex items-center sm:pl-6 sm:border-l border-slate-100">
                        <div className="flex flex-col items-start sm:items-end w-full sm:w-auto">
                          <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">CARTÃO NACIONAL</span>
                          <div className="flex items-center gap-2.5 bg-slate-50 px-3 py-2 rounded-xl border border-slate-200">
                            <IdCard size={14} className="text-blue-500" />
                            <span className="text-xs sm:text-sm font-black text-slate-700 tracking-widest tabular-nums">{patient.N_CNS_DA_PESSOA_CADASTRADA}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8 items-stretch">
                      {/* Details Column (7/12) */}
                      <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                        <div className="flex items-center gap-4 p-3 rounded-2xl bg-white border border-slate-100 shadow-sm hover:shadow-md hover:border-blue-100 transition-all group/item">
                          <div className="w-10 h-10 shrink-0 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500 border border-blue-100/50">
                            <Heart size={18} strokeWidth={2.5} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 mb-0.5">Mãe</p>
                            <p className={`text-xs font-black uppercase truncate ${patient.NOME_DA_MAE_PESSOA_CADASTRADA ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.NOME_DA_MAE_PESSOA_CADASTRADA || '—'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 p-3 rounded-2xl bg-white border border-slate-100 shadow-sm hover:shadow-md hover:border-indigo-100 transition-all group/item">
                          <div className="w-10 h-10 shrink-0 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-500 border border-indigo-100/50">
                            <Calendar size={18} strokeWidth={2.5} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 mb-0.5">Nascimento</p>
                            <p className={`text-xs font-black ${patient.DATA_DE_NASCIMENTO ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.DATA_DE_NASCIMENTO ? `${patient.DATA_DE_NASCIMENTO} (${patient.SEXO || '?'})` : '—'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 p-3 rounded-2xl bg-white border border-slate-100 shadow-sm hover:shadow-md hover:border-amber-100 transition-all group/item">
                          <div className="w-10 h-10 shrink-0 rounded-xl bg-amber-50 flex items-center justify-center text-amber-500 border border-amber-100/50">
                            <Clock size={18} strokeWidth={2.5} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 mb-0.5">Última Atualização</p>
                            <p className={`text-xs font-black ${patient.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO ? 'text-slate-800' : 'text-slate-300'}`}>
                              {patient.DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO || '—'}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Address Column (5/12) */}
                      <div className="lg:col-span-5 h-full">
                        <div className="h-full bg-slate-50/80 rounded-[1.5rem] p-5 border border-slate-100 group-hover/card:bg-white group-hover/card:shadow-lg group-hover/card:border-blue-100 transition-all duration-500 flex flex-col justify-center relative overflow-hidden">
                          <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />
                          
                          <div className="flex items-center gap-3 mb-4 relative z-10">
                            <div className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-blue-500 shadow-sm border border-slate-200">
                              <MapPin size={14} strokeWidth={2.5} />
                            </div>
                            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Endereço Completo</span>
                          </div>
                          
                          <div className="space-y-4 relative z-10">
                            <p className="text-sm font-black text-slate-900 leading-snug uppercase">
                              {patient.TIPO_DE_LOGRADOURO} {patient.LOGRADOURO}
                            </p>
                            <div className="flex items-center gap-6">
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Bairro</span>
                                <span className="text-xs font-bold text-slate-700 uppercase">{patient.BAIRRO_DE_MORADIA}</span>
                              </div>
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">CEP</span>
                                <span className="text-xs font-bold text-slate-700 tabular-nums">{patient.CEP_LOGRADOURO}</span>
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
            <div className="bg-white rounded-[3rem] p-12 sm:p-20 text-center border border-slate-200 shadow-sm animate-in zoom-in-95 duration-700">
              <div className="w-20 h-20 sm:w-24 sm:h-24 bg-slate-50 rounded-[2rem] flex items-center justify-center mx-auto mb-8 text-slate-200 border border-slate-100 group-hover:scale-110 transition-transform">
                <Users size={40} sm:size={48} />
              </div>
              <h3 className="text-xl sm:text-2xl font-black text-slate-900 mb-4 tracking-tight">NENHUM RESULTADO</h3>
              <p className="text-xs sm:text-sm text-slate-400 font-medium max-w-xs mx-auto leading-relaxed uppercase tracking-widest">
                Não encontramos pacientes com o termo <span className="text-blue-600 font-black">"{query}"</span> nesta base de dados.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
