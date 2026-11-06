# releaseflip

Atomic deploys and instant rollback for shared hosting. No SSH needed.

- **Every deploy is a complete new release.** It is uploaded and unpacked beside your live site,
  then switched in all at once. Visitors never see a half-uploaded site.
- **Rollback is one command.** It flips back to the previous release in a moment.
- **Protected files are never overwritten.** `.htaccess`, `config.php`, `uploads/`, your logo
  files: anything you list stays exactly as it is on the server, whatever is in the build.
- **It works over plain HTTPS.** One PHP file on your server receives the upload. There's no SSH,
  no FTP, and no server software to install.

```bash
npx releaseflip deploy dist
```

```
  Packed 214 files from /work/site/dist (3.41 MB)
  Uploading to example.com … 100%
  ✓ Live: 20261106-091204-a1c9e3f
  Previous: 20261105-174410-77d02b1 (roll back with: releaseflip rollback)
```

## How it works

```
home/
├── releaseflip.config.php        your settings and token hash, outside the web root
├── public_html/                  the live site
│   └── releaseflip.php           the receiver
└── .releaseflip-public_html/
    └── releases/                 earlier releases, ready for rollback
```

1. The CLI zips your build folder and uploads it in small chunks, so host upload limits don't
   matter. The server checks every byte against a SHA-256 checksum.
2. The receiver unpacks it into a new release folder. The live site is untouched so far.
3. Protected paths are carried from the live site into the new release. Files are copied;
   folders are moved, so even a large `uploads/` costs nothing. Any copy of a protected path
   inside your build is discarded: the server's version always wins.
4. The new release becomes the web root, and the old site is kept as a release for rollback.

The site you had before your first deploy is kept as the `original` release and is never pruned,
so you can always get back to where you started.

## Quick start

**1. Create the server files**

```bash
npx releaseflip setup
```

This writes `releaseflip-server/releaseflip.php` and `releaseflip-server/releaseflip.config.php`,
and prints a token, shown once. The config already contains the token's hash.

**2. Edit `releaseflip.config.php`**

```php
return [
    'token_sha256' => '…filled in by setup…',
    'docroot' => __DIR__ . '/public_html',
    'protect' => [
        '.htaccess',
        '.user.ini',
        '.well-known/',
        'cgi-bin/',
        'config.php',
        'uploads/',
    ],
    'keep' => 5,
    'flip' => 'rename',
];
```

Keep `.well-known/` and `cgi-bin/` in the list on cPanel: AutoSSL uses `.well-known/` to issue and
renew your certificate.

**3. Upload both files** with your host's file manager:

- `releaseflip.config.php` goes **one folder above** your web root (next to `public_html`).
- `releaseflip.php` goes **into** your web root.

On cPanel, every site's folder usually sits directly in your home folder, so they all share the same
"folder above". Give each site's config its own name, `releaseflip.<site-folder>.config.php`. For
example, `releaseflip.shop.example.com.config.php` for the site in `~/shop.example.com`. The
receiver looks for that name first.

**4. Check the connection**

```bash
export RELEASEFLIP_TOKEN="the token from setup"
npx releaseflip check --url https://example.com/releaseflip.php
```

**5. Deploy**

```bash
npx releaseflip deploy dist --url https://example.com/releaseflip.php
```

Try it on a subdomain first. That's the safest way to learn how your host behaves.

## Commands

| Command | What it does |
|---|---|
| `releaseflip setup [folder]` | Writes the server files and prints a new token |
| `releaseflip deploy [source]` | Uploads a folder and flips it live |
| `releaseflip rollback [release]` | Flips back one release, or to the release you name |
| `releaseflip list` | Shows releases on the server, newest first |
| `releaseflip check` | Tests the connection, PHP zip support and folder permissions |
| `releaseflip token` | Prints a new token and its hash, to rotate the token |

Options: `--url`, `--exclude <pattern>` (repeatable), `--dry-run`.

The token is only ever read from the `RELEASEFLIP_TOKEN` environment variable, never from a file.

### `releaseflip.json`

Save repeating options in your project:

```json
{
  "url": "https://example.com/releaseflip.php",
  "source": "dist",
  "exclude": ["*.map", "drafts/"]
}
```

`.git/`, `node_modules/`, `.DS_Store`, `.env` and `releaseflip.json` itself are always left out.

## GitHub Action

Save the token as a repository secret named `RELEASEFLIP_TOKEN`, then:

```yaml
- uses: actions/checkout@v4

- uses: thisisezra/releaseflip@v0
  with:
    url: https://example.com/releaseflip.php
    token: ${{ secrets.RELEASEFLIP_TOKEN }}
    source: dist
```

A complete workflow is in [`examples/deploy.yml`](examples/deploy.yml). Set `command: rollback` to
roll back from a manual workflow.

## Server settings

| Setting | Default | |
|---|---|---|
| `token_sha256` | required | Hash printed by `setup` or `token` |
| `docroot` | the receiver's folder | The live web root |
| `protect` | `[]` | Paths kept from the server on every deploy. End folders with `/` |
| `keep` | `5` | Releases kept, including the live one. The `original` release is extra and never removed |
| `flip` | `rename` | How the switch happens; see below |
| `chunk_bytes` | `1048576` | Upload chunk size. Lower it if your host rejects 1 MB requests |
| `max_bytes` | `536870912` | Largest package accepted (512 MB) |
| `state` | beside the web root | Where releases are stored. Must be on the same disk as the web root |
| `allow_http` | `false` | Allow deploys without HTTPS. Only for local testing |

`releaseflip.php` and `releaseflip.config.php` are always protected, so a deploy can never remove
the receiver.

## Flip modes

**`rename` (default): works on every host.** The web root stays a normal folder. The switch is two
folder renames in a row, which leaves a gap of well under a millisecond. In testing, 2 of about
2,400 requests made during flips landed in that gap and failed.

**`symlink`: truly atomic.** The web root becomes a symlink to the live release, and switching
replaces it in one operation. In testing, none of about 2,900 requests made during flips failed. It
needs a host that follows a symlinked web root, so test it on a subdomain first. On LiteSpeed it
works, and PHP pages switched immediately. On Apache with PHP-FPM, PHP's path cache
(`realpath_cache_ttl`, 120 seconds by default) may keep running the previous release's PHP code for
up to two minutes after a flip.

**LiteSpeed servers** (common on cPanel hosts) cache open files briefly. For up to about one second
after a flip, a request can still get the previous release's copy of a static file. It is always a
complete file from the old release, never a broken one. This happens in both modes, and it comes
from the server, not from releaseflip.

## Security

- The server stores only a SHA-256 hash of the token and compares it in constant time.
- Deploys are refused over plain HTTP, except to localhost.
- The token is sent in a custom header as well as `Authorization`, because some shared hosts strip
  `Authorization`.
- Uploads are checked against their SHA-256 before anything is unpacked.
- Zip entries with absolute paths, `..`, backslashes or null bytes are rejected, and nothing goes
  live.
- Releases are stored outside the web root.
- Only one deploy or rollback can run at a time.

## Requirements and limits

- **Server:** PHP 8.0 or newer with the `zip` extension (standard on cPanel hosts). The folder
  above your web root must be writable by PHP.
- **CLI:** Node.js 20.15 or newer. No dependencies.
- Up to 65,535 files and 4 GB per release.
- releaseflip deploys files. It does not run database migrations.
- New release folders are created with `0755` permissions.

## Tested

`npm test` builds a fake host (a live site with `.htaccess`, config, brand marks and uploads),
serves it with PHP, and runs every command against it while firing page requests at the site
throughout each flip. It runs once per flip mode:

| | rename | symlink |
|---|---|---|
| Wrong, missing or plain-HTTP tokens refused | pass | pass |
| 3 MB package sent in 256 KB chunks, checksum verified | pass | pass |
| Protected files and folders kept through deploys and rollbacks | pass | pass |
| Files uploaded on the server between deploys survive | pass | pass |
| Rollback steps back in time, down to the original site | pass | pass |
| Old releases pruned, original kept | pass | pass |
| `../` zip paths and corrupted uploads rejected, site unchanged | pass | pass |
| Failed page loads during flips | about 0.1% | 0 |

### On a real host

Also run end to end against a live cPanel subdomain (LiteSpeed, PHP 8.2, HTTPS) in both flip modes,
with four parallel page requests running throughout every deploy and rollback:

| | rename | symlink |
|---|---|---|
| `check`: PHP zip support and permissions | pass | pass |
| 3 MB release sent in 1 MB chunks, arrives byte-identical | pass | pass |
| Live `.htaccess` kept while every release shipped a different one | pass | pass |
| `.well-known/` and `cgi-bin/` untouched | pass | pass |
| Files removed from a release return 404 | pass | pass |
| Rollback walks back one release at a time to the original site, then stops | pass | pass |
| Pruning keeps 5 releases plus the original | pass | pass |
| Failed page loads during flips | 0 of about 500 | 0 of about 260 |
| Previous copy of a static file served after a flip (LiteSpeed) | up to about 1 s | up to about 1 s |
| PHP pages serving the previous release after a flip | n/a | never |

## License

MIT
