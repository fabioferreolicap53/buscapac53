import { Clock, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import TopNavBar from './components/TopNavBar';
import SearchModule from './components/SearchModule';
import SettingsPage from './components/SettingsPage';
import { DataService } from './services/DataService';

export default function App() {
  const [view, setView] = useState<'search' | 'settings'>('search');
  const [showLogin, setShowLogin] = useState(false);
  const [loginForm, setLoginForm] = useState({ user: '', pass: '' });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginForm.user === 'daps.cap53@gmail.com' && loginForm.pass === 'daps2022') {
      setShowLogin(false);
      setView('settings');
      setLoginForm({ user: '', pass: '' });
    } else {
      alert('Acesso negado.');
    }
  };

  const lastUpdate = DataService.getLastUpdate();

  return (
    <div className="min-h-screen bg-slate-50 font-manrope selection:bg-blue-100 selection:text-blue-900 overflow-x-hidden">
      <TopNavBar onSettingsClick={() => setShowLogin(true)} />

      {showLogin && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in duration-300">
          <div className="bg-white w-full max-w-md rounded-[2rem] p-8 shadow-2xl border border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-[#001f3f]" />
            
            <button 
              onClick={() => setShowLogin(false)}
              className="absolute top-6 right-6 p-2 text-slate-400 hover:text-red-500 transition-colors"
            >
              <X size={20} />
            </button>

            <div className="mb-8">
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">Acesso Restrito</h2>
              <p className="text-sm text-slate-500 font-medium">Identifique-se para acessar as configurações.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Usuário</label>
                <input
                  autoFocus
                  type="email"
                  value={loginForm.user}
                  onChange={e => setLoginForm(prev => ({ ...prev, user: e.target.value }))}
                  className="w-full px-5 py-4 bg-slate-50 border border-slate-100 rounded-xl outline-none focus:border-blue-200 focus:bg-white transition-all text-sm"
                  placeholder="seu@email.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Senha</label>
                <input
                  type="password"
                  value={loginForm.pass}
                  onChange={e => setLoginForm(prev => ({ ...prev, pass: e.target.value }))}
                  className="w-full px-5 py-4 bg-slate-50 border border-slate-100 rounded-xl outline-none focus:border-blue-200 focus:bg-white transition-all text-sm"
                  placeholder="••••••••"
                  required
                />
              </div>
              <button
                type="submit"
                className="w-full bg-[#001f3f] text-white py-4 rounded-xl font-black text-xs tracking-widest hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-blue-900/20"
              >
                ENTRAR
              </button>
            </form>
          </div>
        </div>
      )}

      <main className="pt-24 sm:pt-32 pb-16 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          {view === 'search' ? (
            <div className="flex flex-col items-center justify-center min-h-[500px] sm:min-h-[600px]">
              {/* Search Header - Responsive */}
              <div className="text-center mb-10 sm:mb-16 max-w-2xl relative group/header w-full">
                {/* Modern Decorative Elements */}
                <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-64 h-64 bg-blue-600/10 rounded-full blur-[80px] opacity-0 group-hover/header:opacity-100 transition-opacity duration-1000 pointer-events-none" />
                
                <div className="relative z-10 px-4">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 border border-blue-100 mb-6 animate-in fade-in slide-in-from-top-4 duration-1000">
                    <Sparkles size={12} className="text-blue-600" />
                    <span className="text-[10px] font-black text-blue-600 uppercase tracking-[0.2em]">Sistema de Busca Inteligente</span>
                  </div>

                  <h1 className="text-4xl sm:text-5xl md:text-7xl font-black text-slate-900 tracking-tight mb-6 flex flex-col items-center justify-center gap-0">
                    <span className="relative inline-block">
                      BuscaPac
                      <div className="absolute -right-8 -top-2 hidden sm:block">
                        <div className="relative">
                          <div className="absolute inset-0 bg-blue-600 blur-md opacity-20 animate-pulse" />
                          <div className="relative bg-[#001f3f] text-white text-[10px] px-2 py-0.5 rounded-md font-black tracking-tighter">V1.0</div>
                        </div>
                      </div>
                    </span>
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-indigo-600 to-[#001f3f] leading-tight mt-[-0.1em]">
                      5.3
                    </span>
                  </h1>
                  
                  <div className="relative max-w-lg mx-auto">
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-8 h-[1px] bg-gradient-to-r from-transparent to-slate-200 hidden md:block" />
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-8 h-[1px] bg-gradient-to-l from-transparent to-slate-200 hidden md:block" />
                    
                    <p className="text-sm sm:text-base font-bold text-slate-500 leading-relaxed px-10">
                      Localize pacientes do território da AP5.3 de forma rápida e segura
                    </p>
                  </div>
                  
                  <div className="mt-4 flex items-center justify-center gap-4 text-[10px] sm:text-[11px] font-black uppercase tracking-widest text-slate-400">
                    <span className="flex items-center gap-1.5">
                      <div className="w-1 h-1 rounded-full bg-blue-400" />
                      NOME
                    </span>
                    <div className="w-1 h-1 rounded-full bg-slate-200" />
                    <span className="flex items-center gap-1.5">
                      <div className="w-1 h-1 rounded-full bg-indigo-400" />
                      CNS
                    </span>
                  </div>
                </div>
              </div>

              <div className="w-full flex flex-col items-center">
                <SearchModule />
              </div>

              {/* Bottom Status Indicator - Responsive */}
              <div className="mt-12 sm:mt-16 flex flex-col items-center gap-6 w-full">
                <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4 py-2.5 sm:py-2 px-4 sm:px-5 bg-white rounded-2xl sm:rounded-full border border-slate-200 shadow-sm">
                  <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse shrink-0"></span>
                  <span className="text-[10px] sm:text-xs font-bold text-slate-500 text-center sm:text-left leading-tight">
                     Conectado ao Banco de Dados Central (FICHA A V2) <span className="hidden sm:inline">•</span> <br className="sm:hidden" /> Tempo de resposta: 42ms
                   </span>
                </div>
                
                <footer className="flex flex-col items-center gap-3 w-full px-4 opacity-60 hover:opacity-100 transition-opacity duration-500">
                  <div className="h-[1px] w-8 bg-slate-200" />
                  <p className="text-[10px] sm:text-xs font-medium text-slate-400 text-center leading-relaxed">
                    Desenvolvido por <span className="font-bold text-slate-500">Fabio Ferreira de Oliveira</span> <br className="xs:hidden" /> <span className="hidden xs:inline">•</span> DAPS/CAP5.3
                  </p>
                </footer>
              </div>
            </div>
          ) : (
            <SettingsPage onBack={() => setView('search')} />
          )}
        </div>
      </main>
    </div>
  );
}
