const fs = require('fs/promises');
const path = require('path');
const { Runtime, defaults } = require('./runtime');
const r = new Runtime(defaults(), text => console.log(new Date().toISOString(), text));
async function main() {
  const results = [];
  for (const seconds of [600, 3600]) {
    const audio = path.join(__dirname, `fixture-${seconds}.m4a`);
    await r.run(r.settings.ffmpeg, ['-nostdin','-v','error','-y','-stream_loop','-1','-i',path.join(__dirname,'sample.aiff'),'-map','0:a:0','-t',String(seconds),'-c:a','aac',audio]);
    const job = {};
    const checkpoint = async () => fs.writeFile(path.join(__dirname, `benchmark-${seconds}.json`), JSON.stringify(job, null, 2));
    let peakRSS = 0;
    const {execFile} = require('child_process');
    const timer = setInterval(() => execFile('/bin/ps',['-axo','rss=,comm='],(e,out) => {
      if (!e) { const rss = out.split('\n').filter(l=> /whisper-cli|ollama|ffmpeg/.test(l)).reduce((n,l)=>n+Number(l.trim().split(/\s+/)[0]),0); peakRSS=Math.max(peakRSS,rss); }
    }),1000);
    const start = Date.now();
    try {
      await r.transcribe(job,audio,checkpoint);
      const transcribeSeconds=(Date.now()-start)/1000;
      await r.summarize(job,checkpoint);
      const result={duration:seconds,transcribeSeconds,totalSeconds:(Date.now()-start)/1000,peakProcessRSSMB:Math.round(peakRSS/1024),chunks:job.parts.length,containsExpected: /queue/i.test(job.transcript) && /Friday/i.test(job.transcript),summary:job.summary};
      results.push(result); console.log(JSON.stringify(result));
      await fs.writeFile(path.join(__dirname,'benchmark-results.json'),JSON.stringify(results,null,2));
    } finally { clearInterval(timer); r.shutdown(); }
  }
}
main().catch(e=>{console.error(e);r.shutdown();process.exitCode=1;});
