<?php

return [
    'token_sha256' => 'PASTE-THE-HASH-FROM-releaseflip-token',
    'docroot' => __DIR__ . '/public_html',
    'protect' => [
        '.htaccess',
        '.user.ini',
        'config.php',
        'uploads/',
    ],
    'keep' => 5,
    'flip' => 'rename',
];
