// tts-config.js (optional)
// Provide window.NEURAL_TTS.speak(text, lang)
// NOTE: 真正“自然”通常需要第三方 TTS（Azure / Naver Clova / Google 等）。
// 出于安全原因：不要把真实 API Key 直接写进公开网页里。
// 最佳做法：用 Cloudflare Workers / Vercel / Netlify Functions 做一个小代理。

window.NEURAL_TTS = {
  async speak(text, lang){
    // Placeholder: throw to indicate not configured.
    // Replace this with your own call:
    // 1) fetch("YOUR_PROXY_ENDPOINT", { method:"POST", body: JSON.stringify({ text, lang }) })
    // 2) receive audio/mp3 blob
    // 3) new Audio(URL.createObjectURL(blob)).play()
    throw new Error("Neural TTS 未配置：请把这里替换为你的 TTS 代理接口");
  }
};
