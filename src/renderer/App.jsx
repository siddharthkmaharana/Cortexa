import React, { useState, useEffect } from 'react';

const App = () => {
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.electron.getAppVersion().then(setVersion);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden">
      {/* Status Bar */}
      <header className="h-12 border-b border-slate-800 flex items-center px-4 justify-between bg-slate-900/50 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></div>
          <h1 className="font-bold tracking-tight text-lg">CORTEXA</h1>
          <span className="text-xs text-slate-500 font-mono">v{version}</span>
        </div>
        <div className="flex gap-4 text-xs font-medium text-slate-400">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
            CAMERA ACTIVE
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500"></span>
            BACKEND CONNECTED
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left Panel: Vision */}
        <section className="flex-1 relative border-r border-slate-800 bg-black flex items-center justify-center">
          <div className="text-slate-500 text-center">
            <div className="text-4xl mb-2">📹</div>
            <p className="text-sm font-medium">CAMERA FEED INITIALIZING...</p>
          </div>
          
          {/* Mock Detection Overlays */}
          <div className="absolute top-10 left-10 border-2 border-blue-500/50 w-32 h-32 rounded-lg">
            <div className="absolute -top-6 left-0 bg-blue-500 text-[10px] px-1.5 py-0.5 rounded font-bold">USER_FOCUS 0.98</div>
          </div>
        </section>

        {/* Right Panel: Chat/Agent */}
        <section className="w-[400px] flex flex-col bg-slate-900">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700 max-w-[85%]">
              <p className="text-sm">Hello. I am CORTEXA. I am monitoring the environment and ready for your commands.</p>
            </div>
            <div className="bg-blue-600 p-3 rounded-lg self-end ml-auto max-w-[85%]">
              <p className="text-sm">Identify the object on my desk.</p>
            </div>
            <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700 max-w-[85%]">
              <p className="text-sm italic">Analyzing scene...</p>
            </div>
          </div>

          {/* Input Area */}
          <div className="p-4 border-t border-slate-800">
            <div className="relative">
              <input 
                type="text" 
                placeholder="Ask CORTEXA..." 
                className="w-full bg-slate-950 border border-slate-700 rounded-full py-2.5 pl-4 pr-12 text-sm focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button className="absolute right-2 top-1.5 w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center hover:bg-blue-500 transition-colors">
                <span className="text-xs">🎙️</span>
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
