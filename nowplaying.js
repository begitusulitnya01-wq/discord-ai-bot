const { useQueue } = require('discord-player');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'nowplaying',
  aliases: ['np'],
  description: 'Tampilkan lagu yang sedang diputar',
  async execute(message) {
    const queue = useQueue(message.guild.id);

    if (!queue || !queue.isPlaying()) {
      return message.reply('❌ Tidak ada musik yang sedang diputar!');
    }

    const track = queue.currentTrack;
    const progress = queue.node.createProgressBar();

    const embed = new EmbedBuilder()
      .setTitle('🎵 Sedang Diputar')
      .setDescription(`**[${track.title}](${track.url})**\noleh **${track.author}**`)
      .setThumbnail(track.thumbnail)
      .setColor(0x1DB954)
      .addFields(
        { name: '⏱️ Durasi', value: track.duration, inline: true },
        { name: '🔗 Sumber', value: track.source || 'Tidak diketahui', inline: true },
        { name: '📊 Progress', value: progress || 'N/A' }
      )
      .setFooter({ text: `Diminta oleh ${track.requestedBy?.username || 'Unknown'}` });

    message.reply({ embeds: [embed] });
  },
};
