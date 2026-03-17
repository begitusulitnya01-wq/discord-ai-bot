const { useQueue } = require('discord-player');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'queue',
  aliases: ['q'],
  description: 'Tampilkan antrian lagu saat ini',
  async execute(message) {
    const queue = useQueue(message.guild.id);

    if (!queue || !queue.isPlaying()) {
      return message.reply('❌ Tidak ada musik yang sedang diputar!');
    }

    const currentTrack = queue.currentTrack;
    const tracks = queue.tracks.toArray();

    const embed = new EmbedBuilder()
      .setTitle('🎵 Antrian Musik')
      .setColor(0x1DB954)
      .setThumbnail(currentTrack.thumbnail);

    // Now playing
    embed.addFields({
      name: '▶️ Sedang Diputar',
      value: `**${currentTrack.title}** oleh **${currentTrack.author}**\n⏱️ Durasi: ${currentTrack.duration}`,
    });

    // Queue list
    if (tracks.length > 0) {
      const maxShow = 10;
      const trackList = tracks
        .slice(0, maxShow)
        .map((t, i) => `\`${i + 1}.\` **${t.title}** — ${t.author} \`[${t.duration}]\``)
        .join('\n');

      const remaining = tracks.length > maxShow ? `\n...dan **${tracks.length - maxShow}** lagu lainnya` : '';

      embed.addFields({
        name: `📋 Antrian (${tracks.length} lagu)`,
        value: trackList + remaining,
      });
    } else {
      embed.addFields({
        name: '📋 Antrian',
        value: 'Tidak ada lagu dalam antrian.',
      });
    }

    embed.setFooter({ text: `Total antrian: ${tracks.length} lagu` });

    message.reply({ embeds: [embed] });
  },
};
