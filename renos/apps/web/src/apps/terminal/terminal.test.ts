import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/persistence/db';
import { HOME_ID, createFolder, createFile, initFileSystem } from '@/persistence/fs';
import { COMMANDS, complete, findCommand, type Segment, type TerminalContext } from './commands';
import { splitFlags, tokenize } from './parser';

describe('terminal parser', () => {
  it('splits words, quotes and escapes without evaluating anything', () => {
    expect(tokenize('echo hallo welt')).toEqual({ ok: true, argv: ['echo', 'hallo', 'welt'] });
    expect(tokenize(`cd "Mein Ordner"`)).toEqual({ ok: true, argv: ['cd', 'Mein Ordner'] });
    expect(tokenize(`echo 'a "b" c'`)).toEqual({ ok: true, argv: ['echo', 'a "b" c'] });
    expect(tokenize('cd Mein\\ Ordner')).toEqual({ ok: true, argv: ['cd', 'Mein Ordner'] });
    expect(tokenize('echo $(rm -rf /) `id` ; ls')).toEqual({ ok: true, argv: ['echo', '$(rm', '-rf', '/)', '`id`', ';', 'ls'] });
    expect(tokenize('echo "offen')).toMatchObject({ ok: false });
  });

  it('separates flags from arguments', () => {
    const { flags, rest } = splitFlags(['-la', 'Dokumente', '--', '-x']);
    expect([...flags]).toEqual(['l', 'a']);
    expect(rest).toEqual(['Dokumente', '-x']);
  });
});

describe('terminal commands', () => {
  let output: string[];
  let cwd: string;
  const ctx = (): TerminalContext => ({
    cwdId: cwd,
    setCwd: (id) => (cwd = id),
    userName: 'tester',
    accent: 'blau',
    print: (text) => output.push(typeof text === 'string' ? text : (text as Segment[]).map((s) => s.text).join('')),
    clear: () => (output = []),
    history: ['ls', 'pwd'],
    openApp: () => undefined,
    launchGame: async () => undefined,
    loadGames: async () => ({ games: [], error: 'offline' }),
    sessionStart: Date.now() - 65_000,
  });
  const run = async (line: string) => {
    const parsed = tokenize(line);
    if (!parsed.ok) throw new Error(parsed.error);
    const [name, ...args] = parsed.argv;
    await findCommand(name!)!.run(args, ctx());
  };

  beforeEach(async () => {
    await db.delete();
    await db.open();
    await initFileSystem();
    output = [];
    cwd = HOME_ID;
  });

  it('lists, changes and prints directories with real data', async () => {
    await run('pwd');
    expect(output.pop()).toBe('/home/tester');
    await run('ls');
    expect(output.pop()).toContain('Dokumente/');
    await run('cd Dokumente');
    await run('pwd');
    expect(output.pop()).toBe('/home/tester/Dokumente');
    await run('cd ..');
    await run('cd ~/Bilder');
    await run('pwd');
    expect(output.pop()).toBe('/home/tester/Bilder');
    await run('cd /home/tester/Downloads');
    await run('pwd');
    expect(output.pop()).toBe('/home/tester/Downloads');
    await run('cd gibtsnicht');
    expect(output.pop()).toMatch(/nicht gefunden/);
  });

  it('creates folders and reads text files', async () => {
    await run('mkdir Projekte "Zweiter Ordner"');
    await run('ls');
    const listing = output.pop()!;
    expect(listing).toContain('Projekte/');
    expect(listing).toContain("'Zweiter Ordner'/");
    await run('cat Dokumente/Willkommen.txt');
    expect(output.join('\n')).toContain('Willkommen bei RenOS');
    await run('cat Dokumente');
    expect(output.pop()).toMatch(/Ist ein Ordner/);
  });

  it('prints system information without invented hardware values', async () => {
    await run('neofetch');
    const text = output.join('\n');
    expect(text).toContain('RenOS');
    expect(text).toContain('tester@renos');
    expect(text).not.toMatch(/CPU|GPU|RAM|Akku|Battery/i);
    output = [];
    await run('uptime');
    expect(output[0]).toMatch(/1 Min\./);
  });

  it('reports missing games honestly and has help for every command', async () => {
    await run('games');
    expect(output.pop()).toMatch(/offline/);
    await run('help');
    for (const cmd of COMMANDS) expect(output.join('\n')).toContain(cmd.name);
  });

  it('completes commands and paths', async () => {
    expect((await complete('neo', HOME_ID)).completed).toBe('neofetch ');
    expect((await complete('cd Dok', HOME_ID)).completed).toBe('cd Dokumente/');
    await createFolder(HOME_ID, 'Mein Ordner');
    expect((await complete('cd Mein', HOME_ID)).completed).toBe('cd Mein\\ Ordner/');
    await createFile('documents', 'notiz.txt', new Blob(['x']));
    expect((await complete('cat Dokumente/no', HOME_ID)).completed).toBe('cat Dokumente/notiz.txt ');
  });
});
