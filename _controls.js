const { useQueue } = require('discord-player');

// Helper untuk cek voice channel
function checkVoice(message) {
  if (!message.member?.voice?.channel) {
    message.reply('❌ Kamu harus berada di voice channel!');
    return false;
  }
  return true;
}

// Helper untuk ambil queue
function getQueue(message) {
  const queue = useQueue(message.guild.id);
  if (!queue || !queue.isPlaying()) {
    message.reply('❌ Tidak ada musik yang sedang diputar!');
    return null;
  }
  return queue;
}

const skip = {
  name: 'skip',
  description: 'Lewati lagu yang sedang diputar',
  async execute(message) {
    if (!checkVoice(message)) return;
    const queue = getQueue(message);
    if (!queue) return;

    const currentTrack = queue.currentTrack;
    queue.node.skip();
    message.reply(`⏭️ Melewati: **${currentTrack.title}**`);
  },
};

const stop = {
  name: 'stop',
  description: 'Hentikan musik dan kosongkan antrian',
  async execute(message) {
    if (!checkVoice(message)) return;
    const queue = getQueue(message);
    if (!queue) return;

    queue.delete();
    message.reply('⏹️ Musik dihentikan dan antrian dikosongkan.');
  },
};

const pause = {
  name: 'pause',
  description: 'Jeda musik yang sedang diputar',
  async execute(message) {
    if (!checkVoice(message)) return;
    const queue = getQueue(message);
    if (!queue) return;

    if (queue.node.isPaused()) {
      return message.reply('⚠️ Musik sudah dalam kondisi jeda!');
    }

    queue.node.pause();
    message.reply('⏸️ Musik dijeda.');
  },
};

const resume = {
  name: 'resume',
  description: 'Lanjutkan musik yang dijeda',
  async execute(message) {
    if (!checkVoice(message)) return;
    const queue = useQueue(message.guild.id);

    if (!queue) {
      return message.reply('❌ Tidak ada antrian musik aktif!');
    }

    if (!queue.node.isPaused()) {
      return message.reply('⚠️ Musik sedang tidak dijeda!');
    }

    queue.node.resume();
    message.reply('▶️ Musik dilanjutkan.');
  },
};

module.exports = { skip, stop, pause, resume };
