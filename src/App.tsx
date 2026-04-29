import { Clock, Sparkles } from 'lucide-react';
import { useState } from 'react';
import TopNavBar from './components/TopNavBar';
import SearchModule from './components/SearchModule';
import SettingsPage from './components/SettingsPage';
import { DataService } from './services/DataService';

export default function App() {
  const [view, setView] = useState<'search' | 'settings'>('search');
  const lastUpdate = DataService.getLastUpdate();

  return (
    <div className="min-h-screen bg-slate-50 font-manrope selection:bg-blue-100 selection:text-blue-900 overflow-x-hidden">
      <TopNavBar onSettingsClick={() => setView('settings')} />

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
                     Localize pacientes do território da AP5.3 de forma rápida e segura.
                     <span className="block text-xs sm:text-sm text-slate-400 mt-1 font-normal italic">Use nome completo ou o número do CNS.</span>
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
