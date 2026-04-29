import { Shield, Settings } from 'lucide-react';
import { useState } from 'react';

interface TopNavBarProps {
  onSettingsClick: () => void;
}

export default function TopNavBar({ onSettingsClick }: TopNavBarProps) {
  return (
    <header className="bg-white border-b border-slate-200 fixed top-0 z-50 w-full font-manrope antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-14 sm:h-16">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 bg-[#001f3f] rounded-lg flex items-center justify-center shadow-lg shadow-blue-900/20 shrink-0">
              <Shield size={18} className="text-white sm:size-5" />
            </div>
            <span className="text-base sm:text-lg font-black tracking-tighter text-slate-900 whitespace-nowrap">
              BUSCAPAC<span className="text-blue-600">5.3</span>
            </span>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-4">
            <button 
              onClick={onSettingsClick}
              className="p-2 text-slate-400 hover:text-[#001f3f] transition-colors rounded-lg hover:bg-slate-50 shrink-0"
            >
              <Settings size={20} className="sm:size-5" />
            </button>
            <div className="flex items-center gap-2 sm:gap-3 ml-2 sm:ml-4">
              <div className="hidden xs:flex flex-col items-end min-w-0">
                <span className="text-[9px] sm:text-[10px] font-black text-slate-400 uppercase leading-none mb-0.5 truncate w-full text-right">Operador</span>
                <span className="text-xs sm:text-sm font-bold text-slate-700 truncate max-w-[120px]">DAPS/CAP5.3</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
