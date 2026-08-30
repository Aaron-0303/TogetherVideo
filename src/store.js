const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file) { this.file = file; this.data = { rooms: {} }; this.writeChain = Promise.resolve(); }
  async init() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = parsed;
      if (!this.data.rooms || typeof this.data.rooms !== 'object') this.data.rooms = {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[store] state file reset:', error.message);
      await this.save();
    }
  }
  getRoom(code) { return this.data.rooms[code] || null; }
  setRoom(code, room) { this.data.rooms[code] = room; return this.save(); }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.tmp`;
    this.writeChain = this.writeChain.then(async () => { await fs.promises.writeFile(tmp, snapshot, 'utf8'); await fs.promises.rename(tmp, this.file); }).catch((error) => console.error('[store] save failed:', error));
    return this.writeChain;
  }
}
module.exports = JsonStore;
