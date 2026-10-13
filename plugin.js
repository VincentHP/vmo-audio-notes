const { Plugin, PluginSettingTab, Setting, Modal, Notice, TFile, MarkdownView, normalizePath } = require('obsidian');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./core');
const { Runtime, defaults, aborted } = require('./runtime');

module.exports = class AudioNotes extends Plugin {
  async onload() {
    this.disposed = false; this.busy = false; this.toggling = false; this.saving = Promise.resolve(); this.modals = new Set();
    this.state = Object.assign({ settings: defaults(), jobs: [], session: null }, await this.loadData());
    this.state.settings = { ...defaults(), ...this.state.settings };
    this.base = this.app.vault.adapter.getBasePath();
    this.runtime = new Runtime(this.state.settings, text => this.progress(text));
    this.status = this.addStatusBarItem(); this.status.addClass('vmo-audio-status');
    this.status.onclick = () => this.showQueue();
    this.addRibbonIcon('mic-vocal', 'VMO Audio Notes: start / stop recording', () => this.safe(() => this.toggleRecording()));
    this.addCommand({ id: 'record', name: 'Start / stop native recording', callback: () => this.safe(() => this.toggleRecording()) });
    this.addCommand({ id: 'queue', name: 'Show processing queue', callback: () => this.showQueue() });
    this.addCommand({ id: 'cancel', name: 'Cancel current processing', callback: () => this.cancel() });
    this.addCommand({ id: 'toggle-processing', name: 'Pause / resume processing', callback: () => this.safe(() => this.setEnabled(!this.state.settings.enabled)) });
    this.addCommand({ id: 'setup', name: 'Setup / verify local tools', callback: () => this.safe(() => this.setup()) });
    this.addCommand({ id: 'retry', name: 'Retry failed or cancelled jobs', callback: () => this.safe(async () => {
      for (const j of this.state.jobs) if (['error', 'cancelled'].includes(j.status)) { j.status = 'queued'; j.error = ''; }
      await this.persist(); this.kick();
    }) });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && /^(m4a|webm|mp3|wav|ogg|flac|mp4)$/i.test(file.extension)) menu.addItem(item => item.setTitle('Transcribe with VMO Audio Notes').setIcon('mic-vocal').onClick(() => this.safe(() => this.enqueueExisting(file))));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, old) => this.safe(async () => {
      const update = value => value === old ? file.path : value?.startsWith(old + '/') ? file.path + value.slice(old.length) : value;
      for (const j of [...this.state.jobs, ...(this.state.session ? [this.state.session] : [])]) {
        j.source = update(j.source); j.folder = update(j.folder); j.audio = update(j.audio); j.output = update(j.output);
      }
      await this.persist();
    })));
    this.addSettingTab(new AudioSettings(this.app, this));
    for (const j of this.state.jobs) if (j.status === 'processing') j.status = 'queued';
    this.app.workspace.onLayoutReady(() => this.safe(async () => { await this.recover(); await this.persist(); this.progress('Ready'); this.kick(); }));
  }
  safe(fn) { return Promise.resolve().then(fn).catch(e => { new Notice(`VMO Audio Notes: ${e.message}`, 10000); this.progress(e.message); }); }
  persist() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.saving = this.saving.catch(() => {}).then(() => this.saveData(snapshot));
    return this.saving;
  }
  progress(text) {
    this.lastProgress = text;
    if (this.disposed) return;
    const prefix = this.state.session ? 'Recording / saving' : !this.state.settings.enabled ? 'Paused' : text;
    this.status?.setText(`Audio: ${prefix}`);
    for (const m of this.modals) m.render();
  }
  recorder() {
    const r = this.app.internalPlugins?.getEnabledPluginById('audio-recorder');
    if (!r || !['onRecordAudio', 'onStopRecording', 'saveRecording'].every(k => typeof r[k] === 'function') || typeof this.app.vault.getAvailablePathForAttachments !== 'function') throw new Error('Native recorder integration is unavailable in this Obsidian version. Enable the Audio recorder core plugin or update VMO Audio Notes.');
    return r;
  }
  async toggleRecording() {
    if (this.toggling) return;
    this.toggling = true;
    try {
      const r = this.recorder();
      if (this.state.session) {
        if (!r.recording) throw new Error('The recording is being saved. Please wait.');
        r.onStopRecording(); this.progress('Saving recording'); return;
      }
      if (r.recording) throw new Error('A native recording is already running. Stop it before starting an Audio Notes session.');
      const source = this.app.workspace.getActiveFile();
      if (!(source instanceof TFile) || source.extension !== 'md') throw new Error('Open a Markdown note in the folder where you want the transcript, then start recording.');
      const job = { id: crypto.randomUUID(), stamp: C.stamp(), created: new Date().toISOString(), source: source.path, folder: source.parent.path === '/' ? '' : source.parent.path, status: 'queued' };
      this.state.session = job; await this.persist();
      // Core has no public completion event. Intercept only this session's save,
      // keeping native microphone permissions, MediaRecorder, stop and encoding.
      const original = r.saveRecording;
      const plugin = this;
      const wrapper = async function(buffer) {
        try { await plugin.saveRecording(job, buffer, this.extension); }
        catch (error) {
          plugin.pendingAudio = { job, buffer, extension: this.extension };
          plugin.progress('Audio could not be saved — open queue and retry saving');
          new Notice(`Recording save failed: ${error.message}. Keep Obsidian open and use Retry saving audio.`, 0);
        } finally { if (r.saveRecording === wrapper) r.saveRecording = original; plugin.restoreRecorder = null; }
      };
      r.saveRecording = wrapper;
      this.restoreRecorder = () => { if (r.saveRecording === wrapper) r.saveRecording = original; };
      try { await r.onRecordAudio(); }
      catch (error) { this.restoreRecorder(); this.restoreRecorder = null; this.state.session = null; await this.persist(); throw error; }
      if (!r.recording) { this.restoreRecorder(); this.restoreRecorder = null; this.state.session = null; await this.persist(); throw new Error('Recording did not start. Check microphone permission in macOS System Settings.'); }
      this.progress('Recording');
    } finally { this.toggling = false; }
  }
  async saveRecording(job, buffer, extension) {
    const source = this.app.vault.getAbstractFileByPath(job.source);
    if (!job.audio) {
      job.audio = await this.app.vault.getAvailablePathForAttachments(`Recording ${job.stamp.replace(/[- ]/g, '')}`, extension, source instanceof TFile ? source : null);
      await this.persist();
    }
    let audio = this.app.vault.getAbstractFileByPath(job.audio);
    if (!audio) audio = await this.app.vault.createBinary(job.audio, buffer);
    if (!(audio instanceof TFile)) throw new Error('The recording destination is not a file.');
    if (!this.state.jobs.some(j => j.id === job.id)) this.state.jobs.push(job);
    this.state.session = null; this.pendingAudio = null; await this.persist();
    if (source instanceof TFile) {
      const link = this.app.fileManager.generateMarkdownLink(audio, source.path);
      try {
        const view = this.app.workspace.getLeavesOfType?.('markdown').map(leaf => leaf.view).find(v => v.file?.path === source.path && v.editor);
        if (view) {
          // Preserve unsaved editor content when the originating note is still open.
          if (!view.editor.getValue().includes(link)) {
            const line = view.editor.lastLine();
            view.editor.replaceRange(`\n\n!${link}\n`, { line, ch: view.editor.getLine(line).length });
          }
        } else await this.app.vault.process(source, text => text.includes(link) ? text : `${text}\n\n!${link}\n`);
      } catch (e) { new Notice(`Audio saved, but its source-note link could not be inserted: ${e.message}`); }
    }
    this.progress('Recording saved'); this.kick();
  }
  async recover() {
    const j = this.state.session;
    if (!j) return;
    if (j.audio && this.app.vault.getAbstractFileByPath(j.audio) instanceof TFile) {
      if (!this.state.jobs.some(x => x.id === j.id)) this.state.jobs.push(j);
    } else new Notice('A recording was interrupted before native audio was saved. Completed recordings remain in the processing queue.', 12000);
    this.state.session = null;
  }
  async enqueueExisting(file) {
    const prior = this.state.jobs.find(j => j.audio === file.path);
    if (prior) { this.showQueue(); new Notice('This recording is already in the queue. Use Retry if needed.'); return; }
    const source = this.app.workspace.getActiveFile();
    const note = source?.extension === 'md' ? source : null;
    const folder = note ? note.parent.path : file.parent.path;
    this.state.jobs.push({ id: crypto.randomUUID(), created: new Date().toISOString(), stamp: C.stamp(), audio: file.path, source: note?.path || '', folder: folder === '/' ? '' : folder, status: 'queued' });
    await this.persist(); this.kick(); this.showQueue();
  }
  async ensureNote(job) {
    if (!this.app.vault.getAbstractFileByPath(job.folder || '/')) throw new Error('The destination folder was removed. Restore it, then retry.');
    if (job.output) {
      const file = this.app.vault.getAbstractFileByPath(job.output);
      if (file instanceof TFile) {
        const text = await this.app.vault.read(file);
        if (text.includes(C.marker(job))) return file;
        throw new Error('The output note was edited to remove its job marker. Restore that marker before retrying; your edits have been preserved.');
      }
      if (file) throw new Error('A folder occupies the reserved output path.');
    } else {
      let suffix = 0;
      do { job.output = normalizePath(`${job.folder ? job.folder + '/' : ''}Audio Note ${job.stamp}${suffix ? ' ' + suffix : ''}.md`); suffix++; } while (this.app.vault.getAbstractFileByPath(job.output));
      await this.persist();
    }
    const audio = this.app.vault.getAbstractFileByPath(job.audio), source = this.app.vault.getAbstractFileByPath(job.source);
    if (!(audio instanceof TFile)) throw new Error('Original audio was moved or deleted. Restore it, then retry.');
    return this.app.vault.create(job.output, C.noteText(job, this.app.fileManager.generateMarkdownLink(audio, job.output), source instanceof TFile ? this.app.fileManager.generateMarkdownLink(source, job.output) : '_Source note unavailable._'));
  }
  kick() { if (!this.disposed) this.safe(() => this.processQueue()); }
  async processQueue() {
    if (this.busy || !this.state.settings.enabled || this.disposed) return;
    this.busy = true;
    try {
      while (this.state.settings.enabled && !this.disposed) {
        const job = this.state.jobs.find(j => j.status === 'queued');
        if (!job) break;
        this.current = job; this.controller = new AbortController(); const signal = this.controller.signal;
        job.status = 'processing'; job.error = ''; await this.persist();
        try {
          if (!job.transcribed) await this.runtime.transcribe(job, C.inside(this.base, job.audio), () => this.persist(), signal);
          aborted(signal);
          await this.ensureNote(job); // Transcript is durable before any summary call.
          if (!job.summary) await this.runtime.summarize(job, () => this.persist(), signal);
          aborted(signal);
          const file = await this.ensureNote(job);
          await this.app.vault.process(file, text => C.addSummary(text, job));
          job.status = 'done'; job.completed = new Date().toISOString();
          // Completed notes are the durable transcript; keep lightweight queue metadata.
          delete job.parts; delete job.summaries; delete job.transcript; delete job.summary;
          if (!this.disposed) new Notice(`Audio note ready: ${file.path}`);
        } catch (error) {
          job.status = this.disposed || this.pausing ? 'queued' : signal.aborted ? 'cancelled' : 'error';
          job.error = signal.aborted ? '' : error.message;
          if (!signal.aborted && !this.disposed) new Notice(`Audio Notes: ${error.message}`, 10000);
        } finally { await this.persist(); this.current = null; this.controller = null; this.pausing = false; }
      }
    } finally { this.runtime.shutdown(); this.busy = false; this.progress(this.state.jobs.some(j => j.status === 'error') ? 'Needs attention — click to retry' : 'Ready'); }
  }
  cancel() { this.controller?.abort(); this.setupController?.abort(); }
  async setEnabled(value) {
    this.state.settings.enabled = value;
    if (!value && this.controller) { this.pausing = true; this.controller.abort(); }
    await this.persist(); this.progress(value ? 'Ready' : 'Paused');
    if (value) this.kick();
  }
  async setup() {
    if (this.busy || this.setupController) throw new Error('Wait for current processing or cancel it before setup.');
    this.busy = true; this.setupController = new AbortController();
    try { await this.runtime.setup(this.setupController.signal); new Notice('VMO Audio Notes is ready. Use the microphone button to record.'); }
    finally { this.busy = false; this.setupController = null; this.runtime.shutdown(); this.kick(); }
  }
  showQueue() { new QueueModal(this.app, this).open(); }
  onunload() {
    this.disposed = true;
    this.controller?.abort(); this.setupController?.abort(); this.runtime.shutdown();
    // If a recording is active, finish through the session save hook rather than
    // dropping its audio. The hook restores itself once native encoding finishes.
    const r = this.app.internalPlugins?.getEnabledPluginById('audio-recorder');
    if (this.state.session && r?.recording) r.onStopRecording();
    else if (!this.state.session) this.restoreRecorder?.();
    for (const m of this.modals) m.close();
  }
};

class QueueModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.plugin.modals.add(this); this.render(); }
  onClose() { this.plugin.modals.delete(this); this.contentEl.empty(); }
  render() {
    const p = this.plugin, el = this.contentEl; el.empty();
    el.createEl('h2', { text: 'VMO Audio Notes' });
    el.createEl('p', { text: p.lastProgress || 'Ready' });
    new Setting(el).setName('Automatic processing').setDesc('Pausing saves progress. Resume continues queued recordings.').addToggle(t => t.setValue(p.state.settings.enabled).onChange(value => p.safe(() => p.setEnabled(value))));
    new Setting(el).addButton(b => b.setButtonText(p.state.session ? 'Stop recording' : 'Start recording').onClick(() => p.safe(() => p.toggleRecording()))).addButton(b => b.setButtonText('Cancel processing').setDisabled(!p.controller && !p.setupController).onClick(() => p.cancel()));
    if (p.pendingAudio) new Setting(el).setName('Unsaved recording — keep Obsidian open').addButton(b => b.setButtonText('Retry saving audio').setCta().onClick(() => p.safe(async () => { const a = p.pendingAudio; await p.saveRecording(a.job, a.buffer, a.extension); })));
    if (!p.state.jobs.length) el.createEl('p', { text: 'Open a note, then use Start recording. Your audio note will appear beside that note.' });
    for (const job of p.state.jobs.slice().reverse().slice(0, 30)) {
      const row = new Setting(el).setName(`Audio Note ${job.stamp}`).setDesc(`${job.status} · ${job.folder || 'Vault root'}${job.error ? '\n' + job.error : ''}`);
      if (job.output) row.addButton(b => b.setButtonText('Open note').onClick(() => p.app.workspace.openLinkText(job.output, '', true)));
      if (['error', 'cancelled'].includes(job.status)) row.addButton(b => b.setButtonText('Retry').onClick(() => p.safe(async () => { job.status = 'queued'; job.error = ''; await p.persist(); p.kick(); this.render(); })));
    }
  }
}
class AudioSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.p = plugin; }
  display() {
    const el = this.containerEl, p = this.p; el.empty();
    el.createEl('h2', { text: 'VMO Audio Notes' });
    el.createEl('p', { text: 'English transcription and Qwen summaries run on your Mac. Open a note and click the microphone-with-sound-waves button. Click again to stop. Results are saved in the starting note’s folder.' });
    new Setting(el).setName('One-time setup / health check').setDesc('Checks local tools and Qwen. Downloads the English model only if missing or damaged.').addButton(b => b.setButtonText('Setup / verify').onClick(() => { p.showQueue(); p.safe(() => p.setup()); }));
    new Setting(el).setName('Processing queue').addButton(b => b.setButtonText('Open queue').onClick(() => p.showQueue()));
    new Setting(el).setName('Automatic processing').addToggle(t => t.setValue(p.state.settings.enabled).onChange(v => p.safe(() => p.setEnabled(v))));
    el.createEl('h3', { text: 'Local configuration' });
    for (const [key, label] of [['model', 'Ollama model'], ['ollama', 'Ollama executable'], ['whisper', 'Whisper executable'], ['ffmpeg', 'FFmpeg executable'], ['modelPath', 'English Whisper model']]) {
      new Setting(el).setName(label).addText(t => t.setValue(p.state.settings[key]).setDisabled(p.busy).onChange(v => p.safe(async () => { if (p.busy) throw new Error('Pause processing before changing configuration.'); p.state.settings[key] = v.trim(); await p.persist(); })));
    }
    el.createEl('p', { text: 'Assign a shortcut under Settings → Hotkeys → VMO Audio Notes: Start / stop native recording. Keep Obsidian open until recording is saved. Closing during processing resumes completed chunks on next launch.' });
  }
}
