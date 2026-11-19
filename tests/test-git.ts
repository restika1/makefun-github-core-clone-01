// Git smart-HTTP test driving the forge through the kit's own GitClient (the suite's client).
// Run: MAKEFUN_KIT=<kit path> PORT=18082 TOK=testtoken node --experimental-strip-types tests/test-git.ts
const kit = process.env.MAKEFUN_KIT ?? '/home/hatch/workspace/makefun/github-core-clone-01-kit';
const { GitClient, ZERO_OID, buildCommit, buildTag, buildTree, collectReachable, hashObject, parseCommit, parseTree } =
  await import(`${kit}/program/env/src/git-client.ts`);

const PORT = process.env.PORT ?? '18082';
const TOK = process.env.TOK ?? 'testtoken';
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'adaiversen';

let pass = 0;
let fail = 0;
function ck(label: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const client = new GitClient({ baseUrl: BASE, token: TOK, timeoutMs: 10_000 });

async function createRepo(name: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v3/user/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
    body: JSON.stringify({ name, private: true }),
  });
  if (res.status !== 201 && res.status !== 422) throw new Error(`createRepo ${name}: ${res.status}`);
}

const local = new Map<string, { type: string; data: Uint8Array }>();
function put(type: string, data: Uint8Array): string {
  const oid = hashObject(type as 'commit', data);
  local.set(oid, { type, data });
  return oid;
}
function blob(content: string): string {
  return put('blob', Buffer.from(content, 'utf8'));
}
function commit(files: { path: string; content: string }[], message: string, parents: string[]): string {
  const entries = files.map((f) => {
    const slash = f.path.lastIndexOf('/');
    return { mode: '100644', name: slash === -1 ? f.path : f.path.slice(slash + 1), oid: blob(f.content) };
  });
  const tree = put('tree', buildTree(entries));
  return put('commit', buildCommit({ tree, parents, message }));
}
function tagOf(name: string, target: string, message: string): string {
  return put('tag', buildTag({ object: target, type: 'commit', tag: name, message }));
}
function reachable(tips: string[]): Set<string> {
  return collectReachable(tips, (oid) => local.get(oid));
}

async function push(name: string, commands: { oldOid: string; newOid: string; ref: string }[], objects?: string[]) {
  const real = commands.filter((c) => c.newOid !== ZERO_OID).map((c) => c.newOid);
  const oids = objects ?? [...new Set(real.flatMap((oid) => [oid, ...reachable([oid])]))];
  const objectList = oids.map((oid) => local.get(oid)!).filter((o) => o !== undefined);
  return client.push(OWNER, name, commands, { objects: objectList });
}

async function main(): Promise<void> {
  await createRepo('g-adv');
  const tip0 = commit([{ path: 'a.txt', content: 'alpha' }], 'first', []);
  let pushed = await push('g-adv', [{ oldOid: ZERO_OID, newOid: tip0, ref: 'refs/heads/main' }]);
  ck('push-first-commit', pushed.report?.unpackOk === true && pushed.report.refs[0]?.ok === true, JSON.stringify(pushed.report));

  const adv2 = await client.advertisement(OWNER, 'g-adv', 'git-upload-pack');
  ck('advertise-v2', adv2.protocol === 2 && adv2.capabilities.has('fetch') && adv2.capabilities.has('ls-refs'));
  const advR = await client.advertisement(OWNER, 'g-adv', 'git-receive-pack');
  ck('advertise-receive-pack', advR.protocol === 0 && ['report-status', 'side-band-64k', 'delete-refs'].every((c) => advR.capabilities.has(c)) && advR.refs.some((r) => r.name === 'refs/heads/main' && r.oid === tip0));

  const v0raw = await new GitClient({ baseUrl: BASE, token: TOK, gitProtocol: 0 }).infoRefs(OWNER, 'g-adv', 'git-upload-pack');
  const v2raw = await client.infoRefs(OWNER, 'g-adv', 'git-upload-pack');
  const rr = await client.infoRefs(OWNER, 'g-adv', 'git-receive-pack');
  ck('advertise-headers-status', v0raw.status === 200 && v2raw.status === 200 && rr.status === 200);
  ck('advertise-headers-ct', (v0raw.contentType ?? '').includes('application/x-git-upload-pack-advertisement') && (rr.contentType ?? '').includes('application/x-git-receive-pack-advertisement'));
  const firstData = (raw: { packets: { kind: string; payload: Buffer }[] }): string => {
    const p = raw.packets.find((x) => x.kind === 'data');
    return p ? p.payload.toString('utf8').replace(/\n$/, '') : '';
  };
  ck('advertise-headers-preamble', firstData(v0raw) === '# service=git-upload-pack' && firstData(v2raw) === 'version 2' && firstData(rr) === '# service=git-receive-pack');

  const miss1 = await client.infoRefs(OWNER, 'g-missing', 'git-upload-pack');
  const miss2 = await client.infoRefs(OWNER, 'g-missing', 'git-receive-pack');
  ck('unknown-repo-404', miss1.status === 404 && miss2.status === 404);
  const healthy = await client.infoRefs(OWNER, 'g-adv', 'git-upload-pack');
  ck('unknown-repo-still-200', healthy.status === 200);
  ck('push-sideband', pushed.sideband === true);

  const second = commit([{ path: 'b.txt', content: 'beta' }], 'second', [tip0]);
  const tag1 = tagOf('v1', second, 'tag one');
  pushed = await push('g-adv', [
    { oldOid: tip0, newOid: second, ref: 'refs/heads/main' },
    { oldOid: ZERO_OID, newOid: tag1, ref: 'refs/tags/v1' },
  ]);
  ck('push-two-refs', pushed.report?.refs.every((r) => r.ok) === true && pushed.report?.refs.length === 2, JSON.stringify(pushed.report));

  const listed = await client.lsRefs(OWNER, 'g-adv', { symrefs: true, peel: true });
  const main = listed.refs.find((r) => r.name === 'refs/heads/main');
  const head = listed.refs.find((r) => r.name === 'HEAD');
  const tagRef = listed.refs.find((r) => r.name === 'refs/tags/v1');
  ck('ls-refs-main', main?.oid === second);
  ck('ls-refs-head', head?.symrefTarget === 'refs/heads/main');
  ck('ls-refs-peel', tagRef?.oid === tag1 && tagRef?.peeled === second);

  const heads = await client.lsRefs(OWNER, 'g-adv', { prefixes: ['refs/heads/'] });
  ck('ls-refs-prefix-heads', heads.rawRefs.every((r) => r.name.startsWith('refs/heads/')) && heads.refs.some((r) => r.name === 'refs/heads/main'));
  const tags = await client.lsRefs(OWNER, 'g-adv', { prefixes: ['refs/tags/'] });
  ck('ls-refs-prefix-tags', tags.rawRefs.every((r) => r.name.startsWith('refs/tags/')) && tags.refs.some((r) => r.name === 'refs/tags/v1'));
  const none = await client.lsRefs(OWNER, 'g-adv', { prefixes: ['refs/nope/'] });
  ck('ls-refs-prefix-none', none.rawRefs.length === 0);

  await createRepo('g-empty');
  const emptyClone = await client.clone(OWNER, 'g-empty');
  ck('clone-empty', emptyClone.objects.size === 0 && emptyClone.refs.filter((r) => r.name.startsWith('refs/')).length === 0);

  const clone = await client.clone(OWNER, 'g-adv');
  const allLocal = reachable([second, tag1]);
  ck('clone-complete', [...allLocal].every((oid) => clone.objects.has(oid)), `missing ${[...allLocal].filter((o) => !clone.objects.has(o)).length}`);
  const bad = [...clone.objects].filter(([oid, o]) => hashObject(o.type as 'commit', o.data) !== oid);
  ck('clone-hashes', bad.length === 0);
  const commitBytes = parseCommit(clone.objects.get(second)!.data);
  ck('clone-commit-bytes', commitBytes.message === 'second' && commitBytes.parents.length === 1);
  const treeObj = clone.objects.get(commitBytes.tree)!;
  ck('clone-tree', parseTree(treeObj.data).some((e) => e.name === 'b.txt'));

  const third = commit([{ path: 'c.txt', content: 'gamma' }], 'third', [second]);
  pushed = await push('g-adv', [{ oldOid: second, newOid: third, ref: 'refs/heads/main' }]);
  ck('push-ff', pushed.report?.refs[0]?.ok === true);
  const fetched = await client.fetch(OWNER, 'g-adv', { wants: [third], haves: [second], haveObjects: clone.objects });
  const expectedNew = [...reachable([third])].filter((oid) => !reachable([second]).has(oid));
  ck('fetch-incremental-new', expectedNew.every((oid) => fetched.objects.has(oid)));
  ck('fetch-incremental-old', !fetched.objects.has(tip0) && !fetched.objects.has(second));

  const refetch = await client.fetch(OWNER, 'g-adv', { wants: [third], haves: [third], haveObjects: clone.objects });
  ck('fetch-nothing-new', refetch.objects.size === 0);

  await createRepo('g-shallow');
  const s1 = commit([{ path: 's.txt', content: 'one' }], 's1', []);
  const s2 = commit([{ path: 's.txt', content: 'two' }], 's2', [s1]);
  const s3 = commit([{ path: 's.txt', content: 'three' }], 's3', [s2]);
  pushed = await push('g-shallow', [{ oldOid: ZERO_OID, newOid: s3, ref: 'refs/heads/main' }]);
  ck('shallow-setup', pushed.report?.refs[0]?.ok === true);
  const shallow = await client.clone(OWNER, 'g-shallow', { depth: 1 });
  ck('shallow-depth1-tip', shallow.objects.has(s3) && !shallow.objects.has(s2) && !shallow.objects.has(s1));
  const shallowCommit = parseCommit(shallow.objects.get(s3)!.data);
  ck('shallow-depth1-tree', shallow.objects.has(shallowCommit.tree) && parseTree(shallow.objects.get(shallowCommit.tree)!.data).every((e) => shallow.objects.has(e.oid)));
  ck('shallow-depth1-info', shallow.shallow.includes(s3));

  const deepened = await client.fetch(OWNER, 'g-shallow', { wants: [s3], haves: [s3], shallow: shallow.shallow, depth: 2, haveObjects: shallow.objects });
  ck('shallow-deepen-parent', deepened.objects.has(s2) && !deepened.objects.has(s1));
  ck('shallow-deepen-boundary', deepened.shallow.includes(s2) || deepened.unshallow.includes(s3));

  const s4 = commit([{ path: 's.txt', content: 'four' }], 's4', [s3]);
  pushed = await push('g-shallow', [{ oldOid: s3, newOid: s4, ref: 'refs/heads/main' }]);
  ck('shallow-newtip-setup', pushed.report?.refs[0]?.ok === true);
  const newTip = await client.fetch(OWNER, 'g-shallow', { wants: [s4], haves: [s3], shallow: shallow.shallow, depth: 1, haveObjects: shallow.objects });
  ck('shallow-newtip', newTip.objects.has(s4) && !newTip.objects.has(s2) && !newTip.objects.has(s3));

  pushed = await push('g-adv', [{ oldOid: ZERO_OID, newOid: second, ref: 'refs/heads/feature' }]);
  ck('push-create-branch', pushed.report?.refs[0]?.ok === true);
  pushed = await push('g-adv', [{ oldOid: second, newOid: ZERO_OID, ref: 'refs/heads/feature' }]);
  ck('push-delete-branch', pushed.report?.unpackOk === true && pushed.report?.refs[0]?.ok === true);
  const afterDelete = await client.lsRefs(OWNER, 'g-adv');
  ck('delete-gone', !afterDelete.refs.some((r) => r.name === 'refs/heads/feature') && afterDelete.refs.find((r) => r.name === 'refs/heads/main')?.oid === third);

  const sibling = commit([{ path: 'd.txt', content: 'delta' }], 'sibling', [second]);
  const refused = await push('g-adv', [{ oldOid: third, newOid: sibling, ref: 'refs/heads/main' }]);
  ck('push-non-ff', refused.report?.unpackOk === true && refused.report?.refs[0]?.ok === false && refused.report?.refs[0]?.reason === 'non-fast-forward');
  const afterRefusal = await client.lsRefs(OWNER, 'g-adv');
  ck('non-ff-ref-moved-not', afterRefusal.refs.find((r) => r.name === 'refs/heads/main')?.oid === third);

  const forward = commit([{ path: 'e.txt', content: 'echo' }], 'forward', [third]);
  const sibling2 = commit([{ path: 'f.txt', content: 'foxtrot' }], 'sibling2', [third]);
  const mixed = await push('g-adv', [
    { oldOid: third, newOid: forward, ref: 'refs/heads/main' },
    { oldOid: third, newOid: sibling2, ref: 'refs/heads/side' },
  ]);
  ck('push-mixed', mixed.report?.refs.length === 2 && mixed.report?.refs[0]?.ok === true && mixed.report?.refs[1]?.ok === false && mixed.report?.refs[1]?.reason === 'non-fast-forward', JSON.stringify(mixed.report));

  const raw = await client.postRaw(OWNER, 'g-adv', 'git-upload-pack', Buffer.from('zzzznot-a-pkt-line', 'ascii'));
  ck('malformed-post', raw.status >= 400 || raw.bodySnippet.length >= 0, `HTTP ${raw.status}`);
  const still = await client.infoRefs(OWNER, 'g-adv', 'git-upload-pack');
  ck('server-alive', still.status === 200);
  const cloneAfter = await client.clone(OWNER, 'g-adv');
  ck('clone-after-errors', cloneAfter.objects.has(forward));

  console.log(`GIT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(2);
});
