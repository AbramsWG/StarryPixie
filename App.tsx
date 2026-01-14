
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Type } from "@google/genai";

// --- IndexedDB 核心工具 ---
const DB_NAME = 'XingYuJinLingDB';
const STORE_NAME = 'wordImages';
const DB_VERSION = 1;

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveToDB = async (key: string, value: string) => {
  const db = await initDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const getFromDB = async (key: string): Promise<string | null> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
};

interface WordItem {
  word: string;
  pinyin: string;
  context: string;
  meaning: string;
  distractors: string[];
}

interface BankData {
  wordBank: WordItem[];
  distractorInfo: Record<string, string>;
}

const App: React.FC = () => {
  const [gameState, setGameState] = useState<'start' | 'playing' | 'feedback'>('start');
  const [currentLevel, setCurrentLevel] = useState(0);
  const [options, setOptions] = useState<string[]>([]);
  const [loadingImage, setLoadingImage] = useState(false);
  const [generatedImg, setGeneratedImg] = useState<string | null>(null);
  const [wrongSelections, setWrongSelections] = useState<string[]>([]);
  const [bgColor, setBgColor] = useState('#FFF9E3');
  const [stars, setStars] = useState(0);

  // 词库管理状态
  const [grade, setGrade] = useState<number>(1);
  const [bankData, setBankData] = useState<BankData | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ current: 0, total: 0 });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string>(() => localStorage.getItem('preferred_voice') || '');

  // 初始化加载
  useEffect(() => {
    loadGradeBank(grade);
    const loadVoices = () => {
      const v = window.speechSynthesis.getVoices();
      const chineseVoices = v.filter(voice => voice.lang.includes('zh'));
      setVoices(chineseVoices);
      
      const savedVoice = localStorage.getItem('preferred_voice');
      if (chineseVoices.length > 0 && !savedVoice) {
        const defaultVoice = chineseVoices[0].voiceURI;
        setSelectedVoiceURI(defaultVoice);
        localStorage.setItem('preferred_voice', defaultVoice);
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  const loadGradeBank = async (g: number) => {
    try {
      const cachedBank = localStorage.getItem(`ai_words_${g}`);
      if (cachedBank) {
        setBankData(JSON.parse(cachedBank));
        return;
      }
      const response = await fetch(`./words${g}.json`);
      if (response.ok) {
        const data = await response.json();
        setBankData(data);
      }
    } catch (e) {
      console.error("Failed to load bank", e);
    }
  };

  const handleGradeChange = (g: number) => {
    setGrade(g);
    loadGradeBank(g);
    setCurrentLevel(0);
    setGameState('start');
  };

  const syncImages = async (words: WordItem[]) => {
    setSyncProgress({ current: 0, total: words.length });
    for (let i = 0; i < words.length; i++) {
      const wordObj = words[i];
      const existing = await getFromDB(wordObj.word);
      if (!existing) {
        try {
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
              parts: [{ text: `A vibrant, clear, child-friendly cartoon sticker illustration of ${wordObj.meaning}, simple white background, no text.` }],
            },
            config: { imageConfig: { aspectRatio: "1:1" } }
          });
          for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
              await saveToDB(wordObj.word, `data:image/png;base64,${part.inlineData.data}`);
              break;
            }
          }
          await new Promise(r => setTimeout(r, 800));
        } catch (e) {
          console.warn(`Background sync failed for ${wordObj.word}:`, e);
        }
      }
      setSyncProgress(prev => ({ ...prev, current: i + 1 }));
    }
  };

  const generateBankViaAI = async () => {
    setIsGenerating(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const prompt = `你是一位小学语文教师。请为${grade}年级学生生成一个包含50组易混淆汉字的词库JSON，请基于人教版小学语文教材。要求：1. 针对该年级的识字水平。2. 包含字、拼音、词组、中文描述以及2个形近或音近的干扰项。3. 同时提供干扰项的简单词组说明（存放在 distractorItems 数组中，每个元素包含 char 和 info 字段）。`;
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ text: prompt }],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              wordBank: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    word: { type: Type.STRING },
                    pinyin: { type: Type.STRING },
                    context: { type: Type.STRING },
                    meaning: { type: Type.STRING },
                    distractors: { type: Type.ARRAY, items: { type: Type.STRING } }
                  },
                  required: ["word", "pinyin", "context", "meaning", "distractors"]
                }
              },
              distractorItems: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    char: { type: Type.STRING },
                    info: { type: Type.STRING }
                  },
                  required: ["char", "info"]
                }
              }
            },
            required: ["wordBank", "distractorItems"]
          }
        }
      });

      const result = JSON.parse(response.text);
      const formattedDistractorInfo: Record<string, string> = {};
      if (result.distractorItems && Array.isArray(result.distractorItems)) {
        result.distractorItems.forEach((item: { char: string; info: string }) => {
          formattedDistractorInfo[item.char] = item.info;
        });
      }

      const newData: BankData = { wordBank: result.wordBank, distractorInfo: formattedDistractorInfo };
      localStorage.setItem(`ai_words_${grade}`, JSON.stringify(newData));
      setBankData(newData);
      
      syncImages(result.wordBank);
      alert("AI 词库生成成功！配套图片正在后台同步到本地数据库。");
    } catch (e: any) {
      console.error("AI Generation failed", e);
      alert("词库生成失败: " + (e.message || "未知错误"));
    } finally {
      setIsGenerating(false);
    }
  };

  const clearAICache = () => {
    localStorage.removeItem(`ai_words_${grade}`);
    loadGradeBank(grade);
    setSyncProgress({ current: 0, total: 0 });
    alert("已恢复默认词库。");
  };

  const playInstruction = (textToSay: string) => {
    const synth = window.speechSynthesis;
    synth.cancel(); // 停止当前播放

    const utterance = new SpeechSynthesisUtterance(textToSay);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;
    
    // 关键修复：直接从浏览器获取最新的语音列表，避免 State 引用失效
    const currentVoices = synth.getVoices();
    const voice = currentVoices.find(v => v.voiceURI === selectedVoiceURI) || 
                  currentVoices.find(v => v.lang.includes('zh'));
    
    if (voice) utterance.voice = voice;
    
    // 关键修复：添加微量延迟，确保引擎在 cancel 后能正确接收新的 speak 指令
    setTimeout(() => synth.speak(utterance), 50);
  };

  const generateVisualFeedback = async (wordObj: WordItem) => {
    setLoadingImage(true);
    try {
      const cached = await getFromDB(wordObj.word);
      if (cached) {
        setGeneratedImg(cached);
        setLoadingImage(false);
        return;
      }
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [{ text: `A vibrant, clear, child-friendly cartoon sticker illustration of ${wordObj.meaning}, simple white background, no text.` }],
        },
        config: { imageConfig: { aspectRatio: "1:1" } }
      });
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          const base64 = `data:image/png;base64,${part.inlineData.data}`;
          setGeneratedImg(base64);
          await saveToDB(wordObj.word, base64);
          break;
        }
      }
    } catch (error) {
      console.error("Image generation failed", error);
    } finally {
      setLoadingImage(false);
    }
  };

  const startLevel = useCallback((level: number) => {
    if (!bankData || !bankData.wordBank.length) return;
    const wordObj = bankData.wordBank[level % bankData.wordBank.length];
    const allOptions = [...wordObj.distractors, wordObj.word].sort(() => Math.random() - 0.5);
    setOptions(allOptions);
    setWrongSelections([]);
    setGeneratedImg(null);
    setGameState('playing');
    playInstruction(`请找出：${wordObj.context}的${wordObj.word}`);
  }, [bankData, selectedVoiceURI]);

  const handleSelection = async (selected: string) => {
    if (!bankData) return;
    const target = bankData.wordBank[currentLevel % bankData.wordBank.length];
    if (selected === target.word) {
      setStars(prev => prev + 1);
      setGameState('feedback');
      await generateVisualFeedback(target);
    } else {
      setWrongSelections(prev => [...prev, selected]);
      const distractorContext = bankData.distractorInfo[selected] || '其他的字';
      playInstruction(`不对哦，那是“${distractorContext}”的“${selected}”。请再听一次：找出“${target.context}”的“${target.word}”。`);
    }
  };

  const nextLevel = () => {
    const nextIdx = currentLevel + 1;
    setCurrentLevel(nextIdx);
    startLevel(nextIdx);
  };

  return (
    <div className="min-h-screen transition-colors duration-500 flex flex-col items-center justify-center p-4" style={{ backgroundColor: bgColor }}>
      <div className="fixed top-6 left-6 right-6 flex justify-between items-center z-10">
        <div className="flex items-center gap-4">
          {gameState !== 'start' && (
            <button onClick={() => setGameState('start')} className="p-2 bg-white/70 backdrop-blur rounded-full shadow-sm hover:bg-white transition-colors" title="返回主页">🏠</button>
          )}
          <div className="flex items-center gap-2 bg-white/70 backdrop-blur px-4 py-2 rounded-full shadow-sm">
            <span className="text-2xl">⭐</span>
            <span className="font-bold text-slate-700">{stars}</span>
          </div>
          <button onClick={() => setShowSettings(true)} className="p-2 bg-white/70 backdrop-blur rounded-full shadow-sm hover:rotate-90 transition-transform">⚙️</button>
        </div>
        <div className="flex gap-2">
          {['#FFF9E3', '#E8F5E9', '#F3E5F5'].map(color => (
            <button key={color} onClick={() => setBgColor(color)} className={`w-8 h-8 rounded-full border-2 ${bgColor === color ? 'border-indigo-500 scale-110' : 'border-transparent opacity-60'}`} style={{ backgroundColor: color }} />
          ))}
        </div>
      </div>

      {showSettings && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[2rem] w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="p-6 border-b flex justify-between items-center">
              <h2 className="text-2xl font-bold">实验室设置</h2>
              <button onClick={() => setShowSettings(false)} className="text-2xl">✕</button>
            </div>
            <div className="p-6 overflow-y-auto space-y-8">
              <section>
                <h3 className="text-lg font-bold mb-3 flex items-center gap-2">📖 年级选择</h3>
                <div className="flex gap-2">
                  {[1, 2, 3].map(g => (
                    <button key={g} onClick={() => handleGradeChange(g)} className={`px-6 py-2 rounded-xl font-bold transition-all ${grade === g ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{g} 年级</button>
                  ))}
                </div>
              </section>

              <section>
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-lg font-bold flex items-center gap-2">🧠 AI 词库生成</h3>
                  <div className="flex gap-2">
                    <button onClick={generateBankViaAI} disabled={isGenerating} className="bg-indigo-100 text-indigo-700 px-4 py-1 rounded-lg text-sm font-bold hover:bg-indigo-200 disabled:opacity-50">
                      {isGenerating ? "正在生成..." : "生成并存为我的词库"}
                    </button>
                    <button onClick={clearAICache} className="bg-slate-100 text-slate-600 px-4 py-1 rounded-lg text-sm font-bold hover:bg-slate-200">恢复默认</button>
                  </div>
                </div>
                {syncProgress.total > 0 && (
                  <p className="text-xs font-bold text-emerald-600 mb-2">
                    [已缓存图片: {syncProgress.current}/{syncProgress.total}]
                  </p>
                )}
                <p className="text-xs text-slate-400 mb-2">* 生成后的词库将保存在浏览器缓存中，下次打开依然有效。</p>
                <textarea className="w-full h-48 p-4 bg-slate-50 rounded-xl font-mono text-xs border focus:ring-2 focus:ring-indigo-500 outline-none" value={JSON.stringify(bankData, null, 2)} onChange={(e) => {
                  try {
                    const newData = JSON.parse(e.target.value);
                    setBankData(newData);
                    localStorage.setItem(`ai_words_${grade}`, JSON.stringify(newData));
                  } catch(err) {}
                }} />
              </section>

              <section>
                <h3 className="text-lg font-bold mb-3 flex items-center gap-2">🔊 语音设置</h3>
                <select 
                  className="w-full p-3 bg-slate-100 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500" 
                  value={selectedVoiceURI} 
                  onChange={(e) => {
                    const newVoice = e.target.value;
                    setSelectedVoiceURI(newVoice);
                    localStorage.setItem('preferred_voice', newVoice);
                  }}
                >
                  {voices.map(v => (
                    <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                  ))}
                </select>
              </section>
            </div>
          </div>
        </div>
      )}

      {gameState === 'start' && (
        <div className="text-center animate-in fade-in zoom-in duration-700">
          <div className="inline-block px-4 py-1 bg-indigo-100 text-indigo-700 rounded-full font-bold text-sm mb-4">当前：{grade} 年级模式</div>
          <h1 className="text-5xl md:text-7xl font-bold text-slate-800 mb-8 tracking-tighter">星语精灵</h1>
          <p className="text-xl text-slate-600 mb-8 max-w-md mx-auto leading-relaxed">通过听觉和语义的趣味结合，帮助小朋友精准识别易混淆汉字。</p>
          <div className="flex flex-col items-center gap-8">
            <div className="flex gap-3 justify-center">
              {[1, 2, 3].map(g => (
                <button key={g} onClick={() => handleGradeChange(g)} className={`px-6 py-2 rounded-2xl font-bold transition-all duration-300 border-2 ${grade === g ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg scale-105' : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-500'}`}>{g} 年级</button>
              ))}
            </div>
            <button onClick={() => startLevel(0)} className="group relative bg-indigo-600 hover:bg-indigo-700 text-white text-2xl font-bold px-12 py-6 rounded-3xl shadow-[0_10px_0_0_#4338ca] active:shadow-none active:translate-y-[10px] transition-all">开始探索之旅</button>
          </div>
        </div>
      )}

      {gameState === 'playing' && bankData && bankData.wordBank.length > 0 && (
        <div className="w-full max-w-3xl flex flex-col items-center relative animate-in fade-in slide-in-from-top-4 duration-500">
          <button 
            onClick={() => {
              const target = bankData.wordBank[currentLevel % bankData.wordBank.length];
              playInstruction(`提示：${target.meaning}`);
            }} 
            className="mb-8 px-5 py-2 bg-amber-50 text-amber-600 rounded-full border border-amber-200 text-sm font-bold flex items-center gap-2 hover:bg-amber-100 transition-all shadow-sm hover:scale-105 active:scale-95"
          >
            <span className="text-base">💡</span> 看看小提示
          </button>

          <div className="mb-16">
            <button onClick={() => {
              const target = bankData.wordBank[currentLevel % bankData.wordBank.length];
              playInstruction(`${target.context}的${target.word}`);
            }} className="w-24 h-24 bg-white rounded-full shadow-lg flex items-center justify-center text-4xl hover:scale-110 active:scale-95 transition-transform" title="重听题目">📢</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full">
            {options.map((char, index) => (
              <button key={index} disabled={wrongSelections.includes(char)} onClick={() => handleSelection(char)} className={`aspect-square flex flex-col items-center justify-center text-8xl font-bold rounded-[3rem] transition-all duration-300 ${wrongSelections.includes(char) ? 'bg-slate-200 text-slate-400 scale-90 cursor-not-allowed grayscale' : 'bg-white text-slate-800 shadow-xl hover:-translate-y-2 hover:shadow-2xl active:scale-95'}`} style={{ letterSpacing: '0.1em' }}>
                {char}
                {wrongSelections.includes(char) && (
                  <span className="text-xl mt-2 font-medium bg-slate-100 px-3 py-1 rounded-lg">
                    {bankData.distractorInfo[char] || bankData.wordBank.find(w => w.word === char)?.pinyin || ''}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {gameState === 'feedback' && bankData && (
        <div className="flex flex-col items-center animate-in slide-in-from-bottom duration-500">
          <div className="w-64 h-64 md:w-96 md:h-96 bg-white rounded-[4rem] shadow-2xl flex items-center justify-center overflow-hidden mb-12 relative border-8 border-white">
            {loadingImage ? (
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                <p className="text-slate-400 font-medium">正在变出魔法图片...</p>
              </div>
            ) : generatedImg ? (
              <img src={generatedImg} alt="Feedback" className="w-full h-full object-cover animate-in fade-in zoom-in duration-500" />
            ) : (
              <div className="text-center">
                <span className="text-9xl animate-pulse">✨</span>
                <p className="mt-4 text-slate-400">正在努力加载...</p>
              </div>
            )}
          </div>
          <h2 className="text-4xl font-bold text-slate-800 mb-2">太棒了！</h2>
          <p className="text-2xl text-slate-500 mb-8 font-medium">这就是“{bankData.wordBank[currentLevel % bankData.wordBank.length].context}”的“{bankData.wordBank[currentLevel % bankData.wordBank.length].word}”</p>
          <button onClick={nextLevel} className="bg-emerald-500 hover:bg-emerald-600 text-white text-2xl font-bold px-16 py-5 rounded-2xl shadow-lg hover:scale-105 active:scale-95 transition-all">下一关 ➔</button>
        </div>
      )}

      <div className="fixed bottom-0 left-0 w-full h-24 pointer-events-none opacity-20 flex justify-around items-end pb-8">
        {['☁️', '⭐', '🌈', '🎨'].map((emoji, i) => (
          <span key={i} className="text-6xl animate-bounce" style={{ animationDelay: `${i * 0.2}s` }}>{emoji}</span>
        ))}
      </div>
    </div>
  );
};

export default App;
