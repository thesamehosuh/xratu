/** Encode a browser recording for the README; FFmpeg must be on PATH. */
import spawn from 'cross-spawn';
import { resolve } from 'node:path';

const [input, output, start = '0', duration] = process.argv.slice(2);
if (!input || !output || !Number.isFinite(Number(start)) || Number(start) < 0
    || (duration !== undefined && (!Number.isFinite(Number(duration)) || Number(duration) <= 0))) {
    console.error('Usage: node test/e2e/encode-readme-demo.mjs input.webm output.gif [start-seconds] [duration-seconds]');
    process.exit(1);
}
const trim = ['-ss', start, '-i', resolve(input), ...(duration ? ['-t', duration] : [])];
const result = spawn.sync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', ...trim,
    '-filter_complex', 'fps=16,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', resolve(output),
], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
