<?php
// amx_client_ip() against the ways a request can reach PHP. argv[1]: website/lib/amethyx.php
define('AMX', true);
require $argv[1];
$cases = [
  ['direct public', ['REMOTE_ADDR' => '93.184.216.34'], '93.184.216.34'],
  ['public, spoofed XFF ignored', ['REMOTE_ADDR' => '93.184.216.34', 'HTTP_X_FORWARDED_FOR' => '1.2.3.4'], '93.184.216.34'],
  ['front 192.168, XFF real', ['REMOTE_ADDR' => '192.168.0.10', 'HTTP_X_FORWARDED_FOR' => '93.184.216.34'], '93.184.216.34'],
  ['front, visitor spoofs XFF first', ['REMOTE_ADDR' => '192.168.0.10', 'HTTP_X_FORWARDED_FOR' => '1.2.3.4, 93.184.216.34'], '93.184.216.34'],
  ['front + nginx on loopback', ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_FOR' => '93.184.216.34, 192.168.0.10'], '93.184.216.34'],
  ['only X-Real-IP', ['REMOTE_ADDR' => '192.168.0.10', 'HTTP_X_REAL_IP' => '93.184.216.34'], '93.184.216.34'],
  ['front, nothing passed', ['REMOTE_ADDR' => '192.168.0.10'], '192.168.0.10'],
  ['server own address', ['REMOTE_ADDR' => '5.6.7.8', 'SERVER_ADDR' => '5.6.7.8', 'HTTP_X_REAL_IP' => '93.184.216.34'], '93.184.216.34'],
  ['ipv6 public', ['REMOTE_ADDR' => '::1', 'HTTP_X_FORWARDED_FOR' => '2a00:1450:4010::8a'], '2a00:1450:4010::8a'],
];
$bad = 0;
foreach ($cases as [$name, $server, $want]) {
  $_SERVER = $server;
  $got = amx_client_ip();
  if ($got !== $want) $bad++;
  echo ($got === $want ? 'ok   ' : 'FAIL ') . "$name: $got\n";
}
exit($bad ? 1 : 0);
