const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'help',
  description: 'Tampilkan semua perintah bot musik',
  async execute(message) {
    const prefix = process.env.PREFIX || '!';

    const embed = new EmbedBuilder()
      .setTitle('🎵 Bot Musik - Daftar Perintah')
      .setColor(0x1DB954)
      .setDescription(`Prefix: \`${prefix}\`\n\nBot ini mendukung YouTube, Spotify, SoundCloud, dan URL langsung.`)
      .addFields(
        {
          name: '▶️ Pemutaran',
          value: [
            `\`${prefix}play <judul/url>\` — Putar lagu atau tambahkan ke antrian`,
            `\`${prefix}pause\` — Jeda musik`,
            `\`${prefix}resume\` — Lanjutkan musik`,
            `\`${prefix}stop\` — Hentikan musik & kosongkan antrian`,
            `\`${prefix}skip\` — Lewati lagu saat ini`,
          ].join('\n'),
        },
        {
          name: '📋 Antrian',
          value: [
            `\`${prefix}queue\` / \`${prefix}q\` — Lihat antrian lagu`,
            `\`${prefix}nowplaying\` / \`${prefix}np\` — Lagu yang sedang diputar`,
          ].join('\n'),
        },
        {
          name: '💡 Contoh Penggunaan',
          value: [
            `\`${prefix}play Never Gonna Give You Up\``,
            `\`${prefix}play https://open.spotify.com/track/...\``,
            `\`${prefix}play https://soundcloud.com/...\``,
            `\`${prefix}play https://youtube.com/watch?v=...\``,
          ].join('\n'),
        }
      )
      .setFooter({ text: 'Bot Musik Discord • Powered by discord-player' });

    message.reply({ embeds: [embed] });
  },
};
