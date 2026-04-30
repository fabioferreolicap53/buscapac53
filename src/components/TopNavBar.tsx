import { Shield, Settings, LogOut } from 'lucide-react';
import { useState } from 'react';

interface TopNavBarProps {
  onSettingsClick: () => void;
  onLogoutClick: () => void;
}

export default function TopNavBar({ onSettingsClick, onLogoutClick }: TopNavBarProps) {
  return (
    <header className="bg-[#001f3f] border-b border-white/5 fixed top-0 z-50 w-full font-manrope antialiased shadow-lg shadow-blue-900/10 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-14 sm:h-16">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 bg-white rounded-lg flex items-center justify-center shadow-lg shadow-white/5 shrink-0">
              <Shield size={18} className="text-[#001f3f] sm:size-5" />
            </div>
            <span className="text-base sm:text-lg font-black tracking-tighter text-white whitespace-nowrap">
              BUSCAPAC<span className="text-blue-400">5.3</span>
            </span>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-4">
            <button 
              onClick={onSettingsClick}
              className="p-2 text-white/60 hover:text-white transition-colors rounded-lg hover:bg-white/10 shrink-0 group/nav"
              title="Configurações"
            >
              <Settings size={20} className="sm:size-5 group-hover/nav:rotate-90 transition-transform duration-500" />
            </button>
            <button 
              onClick={onLogoutClick}
              className="p-2 text-white/60 hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10 shrink-0 group/nav"
              title="Sair do Sistema"
            >
              <LogOut size={20} className="sm:size-5 group-hover/nav:-translate-x-1 transition-transform" />
            </button>
            <div className="flex items-center gap-2 sm:gap-3 ml-2 sm:ml-4 border-l border-white/10 pl-4">
              <div className="hidden xs:flex flex-col items-end min-w-0">
                <span className="text-[9px] sm:text-[10px] font-black text-white/40 uppercase leading-none mb-1 truncate w-full text-right">Operador</span>
                <span className="text-xs sm:text-sm font-bold text-white/90 truncate max-w-[120px]">DAPS/CAP5.3</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
