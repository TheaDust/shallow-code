// Do not run even short setup commands until the parent owns this process tree.
process.once('message', async ({ script, args }) => {
  process.argv = [process.execPath, script, ...args];
  process.disconnect();
  try {
    const { pathToFileURL } = await import('node:url');
    await import(pathToFileURL(script).href);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
