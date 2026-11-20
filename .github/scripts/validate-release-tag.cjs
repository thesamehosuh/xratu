const { readFileSync } = require('node:fs');

const [tag, commit] = process.argv.slice(2);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag)) {
    console.error(`Unexpected release tag: ${tag}`);
    process.exit(1);
}
if (tag.slice(1) !== version) {
    console.error(`Tag ${tag} disagrees with package.json version ${version}`);
    process.exit(1);
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error('Expected the checked-out release commit SHA');
    process.exit(1);
}

process.stdout.write(`tag=${tag}\ncommit=${commit}\n`);
