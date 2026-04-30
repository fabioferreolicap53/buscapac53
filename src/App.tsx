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
              <div className="text-center mb-8 sm:mb-12 max-w-2xl relative group/header w-full">
                <div className="absolute -inset-10 bg-blue-500/5 rounded-full blur-[60px] opacity-0 group-hover/header:opacity-100 transition-opacity duration-1000 pointer-events-none hidden sm:block" />
                
                <div className="relative z-10 px-2">
                  <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-slate-900 tracking-tight mb-3 sm:mb-4 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                    BuscaPac
                    <span className="bg-gradient-to-r from-[#001f3f] to-blue-600 bg-clip-text text-transparent">5.3</span>
                  </h1>
                  
                  <p className="text-sm sm:text-base font-medium text-slate-500 leading-relaxed max-w-xl mx-auto">
                     Localize pacientes do território da AP5.3 de forma rápida.
                     <span className="block text-xs sm:text-sm text-slate-400 mt-1 font-normal italic">Use o nome ou o número do CNS.</span>
                   </p>
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
                
                <footer className="flex flex-col items-center gap-3 w-full px-4">
                  <div className="h-[1px] w-12 bg-slate-200" />
                  <p className="text-[9px] sm:text-[10px] font-black text-slate-300 uppercase tracking-[0.2em] sm:tracking-[0.25em] text-center leading-relaxed">
                    Desenvolvido por <span className="text-slate-400">Fabio Ferreira de Oliveira</span> <br className="xs:hidden" /> <span className="hidden xs:inline">-</span> DAPS/CAP5.3
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
