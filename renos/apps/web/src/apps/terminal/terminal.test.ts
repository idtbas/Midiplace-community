import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/persistence/db';
import { HOME_ID, createFolder, createFile, initFileSystem, listChildren, listTrash } from '@/persistence/fs';
import { useWindows } from '@/system/windows';
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

  it('creates, renames, moves, copies and trashes files', async () => {
    await run('touch Dokumente/a.txt neu.txt');
    expect((await listChildren('documents')).map((n) => n.name)).toContain('a.txt');
    await run('mv neu.txt umbenannt.txt');
    await run('mkdir Ziel');
    await run('mv umbenannt.txt Ziel');
    await run('cp Dokumente/a.txt Ziel');
    await run('ls Ziel');
    const listing = output.pop()!;
    expect(listing).toContain('umbenannt.txt');
    expect(listing).toContain('a.txt');
    await run('mv Ziel/a.txt Dokumente/b.txt');
    expect((await listChildren('documents')).map((n) => n.name)).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    await run('trash Ziel');
    expect(output.pop()).toMatch(/Papierkorb/);
    expect((await listTrash()).map((n) => n.name)).toContain('Ziel');
    // Systemordner sind geschützt, „rm“ gibt es bewusst nicht.
    await run('trash Dokumente');
    expect(output.pop()).toMatch(/Systemordner/);
    await run('mv Dokumente Bilder');
    expect(output.pop()).toMatch(/Systemordner/);
    expect(findCommand('rm')).toBeUndefined();
  });

  it('calculates and manages windows', async () => {
    await run('calc 2^10 / 4 + sqrt(16)');
    expect(output.pop()).toBe('260');
    await run('calc 1/0');
    expect(output.pop()).toMatch(/calc: /);
    useWindows.getState().closeAll();
    useWindows.getState().open('notes');
    useWindows.getState().open('calculator');
    output = [];
    await run('ps');
    expect(output.join('\n')).toMatch(/notes[\s\S]*calculator/);
    await run('kill calculator');
    expect(Object.values(useWindows.getState().windows).map((w) => w.appId)).toEqual(['notes']);
    await run('kill 1');
    expect(Object.keys(useWindows.getState().windows)).toHaveLength(0);
    await run('kill 7');
    expect(output.pop()).toMatch(/kein solches Fenster/);
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
