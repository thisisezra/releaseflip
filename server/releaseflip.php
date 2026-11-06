<?php

declare(strict_types=1);

const RF_VERSION = '0.1.0';

function rf_send(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Robots-Tag: noindex');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function rf_fail(int $status, string $code, string $message): void
{
    rf_send($status, ['ok' => false, 'error' => $code, 'message' => $message]);
}

function rf_self(): string
{
    $script = (string) ($_SERVER['SCRIPT_FILENAME'] ?? '');
    return $script !== '' && basename($script) === basename(__FILE__) ? $script : __FILE__;
}

function rf_config(): array
{
    $webroot = dirname(rf_self());
    $candidates = array_unique([dirname($webroot) . '/releaseflip.config.php', $webroot . '/releaseflip.config.php', dirname(__DIR__) . '/releaseflip.config.php', __DIR__ . '/releaseflip.config.php']);
    foreach ($candidates as $path) {
        if (!is_file($path)) {
            continue;
        }
        $config = require $path;
        if (!is_array($config)) {
            rf_fail(500, 'config_invalid', 'releaseflip.config.php must return an array.');
        }
        $config += [
            'docroot' => $webroot,
            'protect' => [],
            'keep' => 5,
            'chunk_bytes' => 1048576,
            'max_bytes' => 536870912,
            'allow_http' => false,
        ];
        $config['docroot'] = rtrim((string) $config['docroot'], '/');
        $config['state'] = rtrim((string) ($config['state'] ?? (dirname($config['docroot']) . '/.releaseflip-' . basename($config['docroot']))), '/');
        $config['config_path'] = $path;
        return $config;
    }
    rf_fail(500, 'config_missing', 'Create releaseflip.config.php one folder above the web root, or next to releaseflip.php.');
    return [];
}

function rf_require_https(array $config): void
{
    if (!empty($config['allow_http'])) {
        return;
    }
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https'
        || (string) ($_SERVER['SERVER_PORT'] ?? '') === '443';
    $host = strtolower((string) preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
    if (!$https && !in_array($host, ['localhost', '127.0.0.1', '[::1]'], true)) {
        rf_fail(403, 'https_required', 'Deploy over HTTPS so the token is never sent in clear text.');
    }
}

function rf_authorize(array $config): void
{
    $expected = strtolower((string) ($config['token_sha256'] ?? ''));
    if (!preg_match('/^[0-9a-f]{64}$/', $expected)) {
        rf_fail(500, 'config_invalid', 'token_sha256 must be the 64-character hash printed by "releaseflip token".');
    }
    $token = (string) ($_SERVER['HTTP_X_RELEASEFLIP_TOKEN'] ?? '');
    if ($token === '') {
        $header = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (stripos($header, 'Bearer ') === 0) {
            $token = substr($header, 7);
        }
    }
    $token = trim($token);
    if ($token === '' || !hash_equals($expected, hash('sha256', $token))) {
        rf_fail(401, 'unauthorized', 'Missing or wrong token.');
    }
}

function rf_paths(array $config): array
{
    $state = $config['state'];
    $paths = [
        'docroot' => $config['docroot'],
        'state' => $state,
        'releases' => $state . '/releases',
        'uploads' => $state . '/uploads',
        'current' => $state . '/current',
        'history' => $state . '/history.json',
        'lock' => $state . '/lock',
    ];
    foreach (['state', 'releases', 'uploads'] as $key) {
        if (!is_dir($paths[$key]) && !mkdir($paths[$key], 0755, true) && !is_dir($paths[$key])) {
            rf_fail(500, 'state_unwritable', 'Cannot create ' . $paths[$key] . '. Check folder permissions.');
        }
    }
    return $paths;
}

function rf_lock(array $paths)
{
    $handle = fopen($paths['lock'], 'c');
    if ($handle === false || !flock($handle, LOCK_EX | LOCK_NB)) {
        rf_fail(409, 'busy', 'Another deploy or rollback is running. Try again in a moment.');
    }
    return $handle;
}

function rf_json_body(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw === false || $raw === '' ? '{}' : $raw, true);
    if (!is_array($data)) {
        rf_fail(400, 'bad_request', 'The request body must be JSON.');
    }
    return $data;
}

function rf_write_atomic(string $path, string $contents): void
{
    $temp = $path . '.tmp-' . bin2hex(random_bytes(4));
    if (file_put_contents($temp, $contents) === false || !rename($temp, $path)) {
        @unlink($temp);
        throw new RuntimeException('Cannot write ' . $path . '.');
    }
}

function rf_current_id(array $paths): ?string
{
    if (!is_file($paths['current'])) {
        return null;
    }
    $id = trim((string) file_get_contents($paths['current']));
    return $id === '' ? null : $id;
}

function rf_history(array $paths): array
{
    if (!is_file($paths['history'])) {
        return [];
    }
    $data = json_decode((string) file_get_contents($paths['history']), true);
    return is_array($data) ? $data : [];
}

function rf_valid_id(string $id): bool
{
    return (bool) preg_match('/^(original-)?\d{8}-\d{6}(-[0-9a-f]{4,16})?$/', $id);
}

function rf_id_time(string $id): string
{
    if (str_starts_with($id, 'original-')) {
        return '0' . $id;
    }
    return preg_match('/(\d{8}-\d{6})/', $id, $match) ? '1' . $match[1] . $id : '';
}

function rf_remove(string $path): void
{
    if (is_link($path) || is_file($path)) {
        @unlink($path);
        return;
    }
    if (!is_dir($path)) {
        return;
    }
    foreach (scandir($path) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        rf_remove($path . '/' . $entry);
    }
    @rmdir($path);
}

function rf_relative(string $name): ?string
{
    if (str_contains($name, "\\") || str_contains($name, "\0")) {
        throw new RuntimeException('Rejected path "' . $name . '": backslashes and null bytes are not allowed.');
    }
    if ($name !== '' && ($name[0] === '/' || preg_match('/^[A-Za-z]:/', $name))) {
        throw new RuntimeException('Rejected path "' . $name . '": absolute paths are not allowed.');
    }
    $parts = [];
    foreach (explode('/', $name) as $segment) {
        if ($segment === '' || $segment === '.') {
            continue;
        }
        if ($segment === '..') {
            throw new RuntimeException('Rejected path "' . $name . '": ".." is not allowed.');
        }
        $parts[] = $segment;
    }
    return $parts ? implode('/', $parts) : null;
}

function rf_protected(array $config): array
{
    $list = [];
    foreach ((array) $config['protect'] as $entry) {
        $relative = rf_relative((string) $entry);
        if ($relative !== null) {
            $list[] = $relative;
        }
    }
    foreach ([rf_self(), $config['config_path']] as $file) {
        if (str_starts_with($file, $config['docroot'] . '/')) {
            $list[] = substr($file, strlen($config['docroot']) + 1);
        }
    }
    $list = array_values(array_unique($list));
    usort($list, fn ($a, $b) => substr_count($a, '/') <=> substr_count($b, '/') ?: strcmp($a, $b));
    return $list;
}

function rf_extract(string $zipPath, string $destination): int
{
    if (!class_exists('ZipArchive')) {
        throw new RuntimeException('PHP zip support is missing on this server. Ask your host to enable the zip extension.');
    }
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        throw new RuntimeException('The upload is not a valid zip file.');
    }
    $entries = [];
    for ($index = 0; $index < $zip->numFiles; $index++) {
        $name = (string) $zip->getNameIndex($index);
        $relative = rf_relative($name);
        if ($relative !== null) {
            $entries[] = [$index, $relative, str_ends_with($name, '/')];
        }
    }
    if (!mkdir($destination, 0755, true)) {
        throw new RuntimeException('Cannot create the release folder.');
    }
    $files = 0;
    foreach ($entries as [$index, $relative, $isDirectory]) {
        $target = $destination . '/' . $relative;
        if ($isDirectory) {
            if (!is_dir($target)) {
                mkdir($target, 0755, true);
            }
            continue;
        }
        $parent = dirname($target);
        if (!is_dir($parent)) {
            mkdir($parent, 0755, true);
        }
        $input = $zip->getStream((string) $zip->getNameIndex($index));
        $output = fopen($target, 'wb');
        if ($input === false || $output === false) {
            throw new RuntimeException('Cannot extract ' . $relative . '.');
        }
        stream_copy_to_stream($input, $output);
        fclose($input);
        fclose($output);
        chmod($target, 0644);
        $files++;
    }
    $zip->close();
    return $files;
}

function rf_flip(array $config, array $paths, string $targetId): array
{
    $target = $paths['releases'] . '/' . $targetId;
    if (!is_dir($target)) {
        throw new RuntimeException('Release ' . $targetId . ' does not exist.');
    }
    $live = $paths['docroot'];
    $useSymlink = ($config['flip'] ?? 'rename') === 'symlink';
    $liveIsLink = is_link($live);
    $currentId = rf_current_id($paths);
    if ($currentId === $targetId) {
        throw new RuntimeException('Release ' . $targetId . ' is already live.');
    }
    $outgoingId = $currentId ?? ('original-' . gmdate('Ymd-His'));
    $outgoing = $paths['releases'] . '/' . $outgoingId;
    if (!$liveIsLink && file_exists($outgoing)) {
        throw new RuntimeException('A release folder named ' . $outgoingId . ' already exists.');
    }

    $moved = [];
    $undo = function () use (&$moved): void {
        foreach (array_reverse($moved) as [$from, $to]) {
            @rename($from, $to);
        }
    };

    foreach (rf_protected($config) as $relative) {
        $source = $live . '/' . $relative;
        if (!file_exists($source) && !is_link($source)) {
            continue;
        }
        $destination = $target . '/' . $relative;
        if (file_exists($destination) || is_link($destination)) {
            rf_remove($destination);
        }
        $parent = dirname($destination);
        if (!is_dir($parent)) {
            mkdir($parent, 0755, true);
        }
        if (is_dir($source) && !is_link($source)) {
            if (!rename($source, $destination)) {
                $undo();
                throw new RuntimeException('Cannot carry protected folder ' . $relative . ' into the new release.');
            }
            $moved[] = [$destination, $source];
        } elseif (!copy($source, $destination)) {
            $undo();
            throw new RuntimeException('Cannot carry protected file ' . $relative . ' into the new release.');
        } else {
            @chmod($destination, fileperms($source) & 0777);
        }
    }

    @chmod($target, 0755);
    if ($useSymlink) {
        if (!$liveIsLink && !rename($live, $outgoing)) {
            $undo();
            throw new RuntimeException('Cannot move the live site aside. Nothing was changed.');
        }
        $parent = dirname($live) . '/';
        $linkTarget = str_starts_with($target, $parent) ? substr($target, strlen($parent)) : $target;
        $temporary = $live . '.releaseflip-' . bin2hex(random_bytes(4));
        if (!symlink($linkTarget, $temporary) || !rename($temporary, $live)) {
            @unlink($temporary);
            if (!$liveIsLink) {
                rename($outgoing, $live);
            }
            $undo();
            throw new RuntimeException('Cannot point the web root at the new release. The previous site was restored.');
        }
    } elseif ($liveIsLink) {
        $previousLink = (string) readlink($live);
        if (!unlink($live) || !rename($target, $live)) {
            @symlink($previousLink, $live);
            $undo();
            throw new RuntimeException('Cannot move the new release into place. The previous site was restored.');
        }
    } else {
        if (!rename($live, $outgoing)) {
            $undo();
            throw new RuntimeException('Cannot move the live site aside. Nothing was changed.');
        }
        if (!rename($target, $live)) {
            rename($outgoing, $live);
            $undo();
            throw new RuntimeException('Cannot move the new release into place. The previous site was restored.');
        }
    }

    rf_write_atomic($paths['current'], $targetId);
    $history = rf_history($paths);
    if (!$history) {
        $history[] = ['id' => $outgoingId, 'at' => gmdate('c')];
    }
    $history[] = ['id' => $targetId, 'at' => gmdate('c')];
    rf_write_atomic($paths['history'], json_encode(array_slice($history, -200), JSON_UNESCAPED_SLASHES));

    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }

    return ['live' => $targetId, 'previous' => $outgoingId];
}

function rf_prune(array $config, array $paths): array
{
    $keep = max(2, (int) $config['keep']);
    $current = rf_current_id($paths);
    $releases = array_values(array_filter(
        scandir($paths['releases']) ?: [],
        fn ($entry) => $entry[0] !== '.' && $entry !== $current && rf_valid_id($entry) && !str_starts_with($entry, 'original-')
    ));
    usort($releases, fn ($a, $b) => strcmp(rf_id_time($a), rf_id_time($b)));
    $removed = [];
    while (count($releases) + 1 > $keep) {
        $oldest = array_shift($releases);
        rf_remove($paths['releases'] . '/' . $oldest);
        $removed[] = $oldest;
    }
    return $removed;
}

function rf_list(array $paths): array
{
    $current = rf_current_id($paths);
    $items = [];
    foreach (scandir($paths['releases']) ?: [] as $entry) {
        if ($entry[0] !== '.' && $entry !== $current && rf_valid_id($entry)) {
            $items[] = ['id' => $entry, 'live' => false];
        }
    }
    if ($current !== null) {
        $items[] = ['id' => $current, 'live' => true];
    }
    usort($items, fn ($a, $b) => strcmp(rf_id_time($b['id']), rf_id_time($a['id'])));
    return $items;
}

function rf_clean_uploads(array $paths): void
{
    foreach (scandir($paths['uploads']) ?: [] as $entry) {
        $path = $paths['uploads'] . '/' . $entry;
        if ($entry[0] !== '.' && is_dir($path) && filemtime($path) < time() - 86400) {
            rf_remove($path);
        }
    }
}

function rf_upload_dir(array $paths): string
{
    $id = (string) ($_GET['upload'] ?? '');
    if (!preg_match('/^[0-9a-f]{16}$/', $id) || !is_dir($paths['uploads'] . '/' . $id)) {
        rf_fail(404, 'upload_missing', 'That upload does not exist or has expired. Start the deploy again.');
    }
    return $paths['uploads'] . '/' . $id;
}

function rf_read_meta(string $dir): array
{
    $meta = json_decode((string) @file_get_contents($dir . '/meta.json'), true);
    if (!is_array($meta)) {
        rf_fail(500, 'upload_corrupt', 'Upload metadata is unreadable. Start the deploy again.');
    }
    return $meta;
}

function rf_main(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        rf_fail(405, 'post_only', 'releaseflip only accepts POST requests from the releaseflip CLI.');
    }
    $config = rf_config();
    rf_require_https($config);
    rf_authorize($config);
    $paths = rf_paths($config);
    $action = (string) ($_GET['action'] ?? '');

    if ($action === 'ping') {
        rf_send(200, [
            'ok' => true,
            'version' => RF_VERSION,
            'php' => PHP_VERSION,
            'zip' => class_exists('ZipArchive'),
            'docroot_writable' => is_writable(dirname($paths['docroot'])),
            'live' => rf_current_id($paths),
            'chunk_bytes' => (int) $config['chunk_bytes'],
        ]);
    }

    if ($action === 'list') {
        rf_send(200, ['ok' => true, 'releases' => rf_list($paths)]);
    }

    if ($action === 'begin') {
        $body = rf_json_body();
        $size = (int) ($body['size'] ?? 0);
        $sha = strtolower((string) ($body['sha256'] ?? ''));
        if ($size <= 0 || $size > (int) $config['max_bytes']) {
            rf_fail(413, 'too_large', 'The package is empty or larger than max_bytes (' . (int) $config['max_bytes'] . ' bytes).');
        }
        if (!preg_match('/^[0-9a-f]{64}$/', $sha)) {
            rf_fail(400, 'bad_request', 'sha256 must be a 64-character hex hash.');
        }
        rf_clean_uploads($paths);
        $id = bin2hex(random_bytes(8));
        $dir = $paths['uploads'] . '/' . $id;
        mkdir($dir, 0700, true);
        file_put_contents($dir . '/meta.json', json_encode(['size' => $size, 'sha256' => $sha, 'received' => 0]));
        touch($dir . '/package.zip');
        rf_send(200, ['ok' => true, 'upload' => $id, 'chunk_bytes' => (int) $config['chunk_bytes']]);
    }

    if ($action === 'chunk') {
        $dir = rf_upload_dir($paths);
        $meta = rf_read_meta($dir);
        $offset = (int) ($_GET['offset'] ?? -1);
        if ($offset !== (int) $meta['received']) {
            rf_send(409, [
                'ok' => false,
                'error' => 'out_of_order',
                'message' => 'Expected the chunk at byte ' . (int) $meta['received'] . '.',
                'received' => (int) $meta['received'],
            ]);
        }
        $limit = (int) $config['chunk_bytes'];
        $input = fopen('php://input', 'rb');
        $output = fopen($dir . '/package.zip', 'ab');
        $written = stream_copy_to_stream($input, $output, $limit + 1);
        fclose($input);
        fclose($output);
        if ($written === false || $written === 0 || $written > $limit) {
            rf_remove($dir);
            rf_fail(400, 'bad_chunk', 'Chunks must be between 1 byte and chunk_bytes. Start the deploy again.');
        }
        $meta['received'] += $written;
        if ($meta['received'] > $meta['size']) {
            rf_remove($dir);
            rf_fail(400, 'too_much_data', 'More data arrived than announced. Start the deploy again.');
        }
        file_put_contents($dir . '/meta.json', json_encode($meta));
        rf_send(200, ['ok' => true, 'received' => $meta['received']]);
    }

    if ($action === 'finish') {
        $dir = rf_upload_dir($paths);
        $meta = rf_read_meta($dir);
        $lock = rf_lock($paths);
        $package = $dir . '/package.zip';
        if ((int) $meta['received'] !== (int) $meta['size'] || filesize($package) !== (int) $meta['size']) {
            rf_remove($dir);
            rf_fail(400, 'incomplete', 'The upload is incomplete. Nothing was changed.');
        }
        if (!hash_equals($meta['sha256'], hash_file('sha256', $package))) {
            rf_remove($dir);
            rf_fail(400, 'checksum_mismatch', 'The upload is corrupted (checksum mismatch). Nothing was changed.');
        }
        $releaseId = gmdate('Ymd-His') . '-' . substr($meta['sha256'], 0, 7);
        $release = $paths['releases'] . '/' . $releaseId;
        if (file_exists($release) || rf_current_id($paths) === $releaseId) {
            rf_remove($dir);
            rf_fail(409, 'duplicate', 'This exact package was deployed less than a second ago.');
        }
        try {
            $files = rf_extract($package, $release);
            $result = rf_flip($config, $paths, $releaseId);
        } catch (Throwable $error) {
            rf_remove($release);
            rf_remove($dir);
            rf_fail(422, 'deploy_failed', $error->getMessage());
        }
        rf_remove($dir);
        $removed = rf_prune($config, $paths);
        flock($lock, LOCK_UN);
        rf_send(200, ['ok' => true, 'files' => $files, 'pruned' => $removed] + $result);
    }

    if ($action === 'rollback') {
        $body = rf_json_body();
        $lock = rf_lock($paths);
        $current = rf_current_id($paths);
        if ($current === null) {
            rf_fail(409, 'nothing_to_roll_back', 'No releaseflip deploy has gone live yet.');
        }
        $target = (string) ($body['to'] ?? '');
        if ($target === '') {
            foreach (rf_list($paths) as $release) {
                if (!$release['live'] && strcmp(rf_id_time($release['id']), rf_id_time($current)) < 0) {
                    $target = $release['id'];
                    break;
                }
            }
        }
        if ($target === '' || !rf_valid_id($target)) {
            rf_fail(404, 'no_release', 'There is no earlier release to roll back to.');
        }
        try {
            $result = rf_flip($config, $paths, $target);
        } catch (Throwable $error) {
            rf_fail(422, 'rollback_failed', $error->getMessage());
        }
        flock($lock, LOCK_UN);
        rf_send(200, ['ok' => true] + $result);
    }

    rf_fail(400, 'unknown_action', 'Unknown action.');
}

rf_main();
