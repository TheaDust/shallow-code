import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { loadRequirementCatalog } from "../src/catalog.js";

const fixture = resolve("test/fixtures/requirements.yaml");

test("Catalog preserves atomic requirements and source evidence in declaration order", async () => {
  const catalog = await loadRequirementCatalog(fixture);

  assert.deepEqual(
    catalog.requirements.map((requirement) => requirement.id),
    ["REQ-A", "REQ-B", "REQ-C"],
  );
  assert.deepEqual(catalog.statusById, {
    "REQ-A": "todo",
    "REQ-B": "todo",
    "REQ-C": "todo",
  });

  const first = catalog.requirements[0];
  assert.deepEqual(first.folderPath, ["ROOT", "AREA-A"]);
  assert.equal(first.declarationIndex, 0);
  assert.equal(first.name, "Create a profile");
  assert.match(first.text, /keeps the value/);
  assert.deepEqual(first.dependencyIds, []);
  assert.deepEqual(first.references, ["reference/profile.png"]);
  assert.deepEqual(first.exactUiStrings, [
    "Profile name",
    "Save",
    "Profile name",
    "Save",
    "Save",
    "Name is required",
  ]);
  assert.deepEqual(first.scenarios, [
    "Save a profile\nGIVEN: The profile page is open.\nWHEN: The user fills “Profile name” and clicks `Save`.\nTHEN: The saved name remains visible after refresh.",
    "Reject an empty profile\nWHEN: The user clicks `Save` without a name.\nTHEN: The page displays “Name is required”.",
  ]);
  assert.equal(first.scenarioContracts?.[0].id, "REQ-A::0");
  assert.deepEqual(first.scenarioContracts?.[0].steps.at(-1), { keyword: "THEN", content: "The saved name remains visible after refresh." });
  assert.deepEqual(first.product, {
    kind: "generic_web",
    rootId: "ROOT",
    rootName: "Demo Product",
    description: "Root description.",
    seedData: [],
  });
  assert.deepEqual(first.ancestors, [
    { id: "AREA-A", name: "Account Area", description: "Account features." },
  ]);
});

test("Catalog carries ancestor visuals and quoted UI contracts without including sibling evidence", async () => {
  await withYaml(JSON.stringify({ id: "ROOT", name: "App", type: "FOLDER", children: [
    { id: "AREA", name: "Area", type: "FOLDER", description: 'Click "Expand". ![layout](reference/layout.png)',
      visual_reference: ["reference/fields.png"], children: [
        { id: "A", name: "Editor", type: "ATOMIC", description: 'Edit "Title" then `Save`. ![editor](reference/editor.png)',
          scenarios: [{ name: "Save", steps: [{ keyword: "THEN", content: 'Show "Saved".' }] }] },
      ] },
    { id: "B", name: "Other", type: "ATOMIC", description: 'Click "Remove". ![other](reference/other.png)' },
  ] }), async file => {
    const { requirements: [a, b] } = await loadRequirementCatalog(file);
    assert.deepEqual(a.references, ["reference/editor.png", "reference/layout.png", "reference/fields.png"]);
    assert.deepEqual(a.exactUiStrings, ["Expand", "Title", "Save", "Saved"]);
    assert.deepEqual(b.exactUiStrings, ["Remove"]);
    assert.deepEqual(b.references, ["reference/other.png"]);
  });
});

test("Catalog classifies known product roots exactly and unknown roots as generic web", async () => {
  await withYaml(
    `id: ROOT\nname: GitHub Collaboration Platform Core Requirements\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: []\n    description: One\n`,
    async (file) => {
      const catalog = await loadRequirementCatalog(file);
      assert.equal(
        catalog.requirements[0].product.kind,
        "repository_collaboration",
      );
    },
  );
  await withYaml(
    `id: ROOT\nname: GitHub - Stage 2\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: []\n    description: One\n`,
    async (file) => {
      const catalog = await loadRequirementCatalog(file);
      assert.equal(catalog.requirements[0].product.kind, "repository_collaboration");
      assert.equal(catalog.requirements[0].product.stage?.index, 2);
    },
  );
  await withYaml(
    `id: ROOT\nname: Core Requirements for an Online Spreadsheet Data Workspace\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: []\n    description: One\n`,
    async (file) => {
      const catalog = await loadRequirementCatalog(file);
      assert.equal(catalog.requirements[0].product.kind, "spreadsheet");
    },
  );
  await withYaml(
    `id: ROOT\nname: Something Else\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: []\n    description: One\n`,
    async (file) => {
      const catalog = await loadRequirementCatalog(file);
      assert.equal(catalog.requirements[0].product.kind, "generic_web");
    },
  );
});

test("Catalog recognises generic progressive stages and keeps earlier-stage dependencies external", async () => {
  await withYaml(
    `id: ROOT
name: Inventory Workspace — Phase 2
type: FOLDER
dependencies: []
description: Add the next set of inventory capabilities.
children:
  - id: REQ-3
    name: Repositories
    type: FOLDER
    dependencies: [REQ-1-1-2]
    description: Repository work.
    children:
      - id: REQ-3-1
        name: Browse repositories
        type: ATOMIC
        dependencies: []
        description: Browse repositories.
      - id: REQ-3-2
        name: Edit repositories
        type: ATOMIC
        dependencies: [REQ-3-1]
        description: Edit repositories.
`,
    async (file) => {
      const catalog = await loadRequirementCatalog(file);
      assert.deepEqual(catalog.requirements[0].product.stage, {
        index: 2,
        currentStageTestsOnly: true,
      });
      assert.equal(catalog.requirements[0].product.kind, "generic_web");
      assert.deepEqual(catalog.requirements[0].dependencyIds, []);
      assert.deepEqual(catalog.requirements[0].externalDependencyIds, ["REQ-1-1-2"]);
      assert.deepEqual(catalog.requirements[1].dependencyIds, ["REQ-3-1"]);
      assert.deepEqual(catalog.requirements[1].externalDependencyIds, ["REQ-1-1-2"]);
    },
  );
});

test("Catalog recognises Evolution increments and preserves product classification and optional stages", async () => {
  for (const [name, kind, stageIndex] of [
    ["GitHub - Evolution", "repository_collaboration", undefined],
    ["Evolution - GitHub", "repository_collaboration", undefined],
    ["GitHub - eVoLuTiOn 2", "repository_collaboration", undefined],
    ["GitHub (Evolution)", "repository_collaboration", undefined],
    ["GitHub [Evolution]", "repository_collaboration", undefined],
    ["Evolution 2 - GitHub", "repository_collaboration", undefined],
    ["GitHub：Evolution", "repository_collaboration", undefined],
    ["GitHub Collaboration Platform Core Requirements - Evolution", "repository_collaboration", undefined],
    ["Core Requirements for an Online Spreadsheet Data Workspace - Evolution", "spreadsheet", undefined],
    ["Evolution Requirements for an Online Spreadsheet Data Workspace", "spreadsheet", undefined],
    ["Evolution Requirements for Inventory Workspace", "generic_web", undefined],
    ["Inventory Workspace - Evolution", "generic_web", undefined],
    ["GitHub - Evolution - Stage 2", "repository_collaboration", 2],
    ["GitHub - Stage 2 - Evolution", "repository_collaboration", 2],
    ["GitHub (Evolution) - Phase 3", "repository_collaboration", 3],
  ] as const) {
    await withYaml(JSON.stringify({ id: "ROOT", name, type: "FOLDER", children: [
      { id: "REQ-3", name: "New area", type: "FOLDER", dependencies: ["REQ-1"], children: [
        { id: "REQ-3-1", name: "Browse", type: "ATOMIC", dependencies: ["REQ-2"], description: "Browse existing records." },
        { id: "REQ-3-2", name: "Edit", type: "ATOMIC", dependencies: ["REQ-3-1"], description: "Edit existing records." },
      ] },
    ] }), async file => {
      const catalog = await loadRequirementCatalog(file);
      const [first, second] = catalog.requirements;
      assert.equal(first.product.rootName, name);
      assert.equal(first.product.evolution, true);
      assert.equal(first.product.kind, kind);
      assert.equal(first.product.stage?.index, stageIndex);
      assert.deepEqual(first.dependencyIds, []);
      assert.deepEqual(first.externalDependencyIds, ["REQ-1", "REQ-2"]);
      assert.deepEqual(second.dependencyIds, ["REQ-3-1"]);
      assert.deepEqual(second.externalDependencyIds, ["REQ-1"]);
      assert.deepEqual(catalog.statusById, { "REQ-3-1": "todo", "REQ-3-2": "todo" });
    });
  }
});

test("Catalog requires a mode marker or inherited application context to accept prior-increment IDs", async () => {
  for (const name of ["Inventory Workspace", "Evolutionary Workspace", "Pet Evolution Tracker", "Evolution CRM",
    "GitHub Evolution", "Pet - Evolution Tracker", "GitHub (Evolution CRM)", "Evolution Requirements Tracker"]) {
    await withYaml(JSON.stringify({ id: "ROOT", name, type: "FOLDER", children: [
      { id: "REQ-99", name: "Evolution controls", type: "ATOMIC", description: "Display records." },
    ] }), async file => {
      const { requirements: [requirement] } = await loadRequirementCatalog(file);
      assert.equal(requirement.product.evolution, undefined);
      assert.equal(requirement.product.rootName, name);
    });
    await withYaml(JSON.stringify({ id: "ROOT", name, type: "FOLDER", children: [
      { id: "REQ-99", name: "Evolution controls", type: "ATOMIC", dependencies: ["REQ-1"], description: "Display records." },
    ] }), async file => {
      await assert.rejects(loadRequirementCatalog(file), /Unknown dependency REQ-1/);
    });
  }
});

test("An inherited application establishes Evolution context without changing the requirement title", async () => {
  await withYaml(JSON.stringify({ id: "ROOT", name: "GitHub", type: "FOLDER", children: [
    { id: "REQ-NEW", name: "New feature", type: "ATOMIC", dependencies: ["REQ-OLD"], description: "Extend existing records." },
  ] }), async file => {
    await assert.rejects(loadRequirementCatalog(file), /Unknown dependency REQ-OLD/);
    const catalog = await loadRequirementCatalog(file, { inheritedApplication: true });
    const [requirement] = catalog.requirements;
    assert.equal(catalog.tree.name, "GitHub");
    assert.equal(requirement.product.rootName, "GitHub");
    assert.equal(requirement.product.kind, "repository_collaboration");
    assert.equal(requirement.product.evolution, true);
    assert.deepEqual(requirement.externalDependencyIds, ["REQ-OLD"]);
    assert.deepEqual(requirement.dependencyIds, []);
    assert.deepEqual(catalog.statusById, { "REQ-NEW": "todo" });
  });
});

test("Final requirement trees preserve their full current scope and inherited dependencies", async () => {
  for (const [product, kind, requirementCount, scenarioCount, expectedExternal] of [
    ["github", "repository_collaboration", 52, 114, []],
    ["sheet", "spreadsheet", 10, 30, ["REQ-1-1-1", "REQ-1-3-2", "REQ-3-1-3", "REQ-4-1-1"]],
  ] as const) {
    const file = resolve(`data/final/hackathon-evolution--${product}/requirements.yaml`);
    const catalog = await loadRequirementCatalog(file, { inheritedApplication: true });
    assert.equal(catalog.requirements.length, requirementCount);
    assert.equal(catalog.requirements.reduce((sum, item) => sum + item.scenarios.length, 0), scenarioCount);
    assert.equal(catalog.requirements[0].product.kind, kind);
    assert.equal(catalog.requirements[0].product.evolution, true);
    assert.deepEqual([...new Set(catalog.requirements.flatMap(item => item.externalDependencyIds ?? []))].sort(), expectedExternal);
    assert.deepEqual(Object.keys(catalog.statusById), catalog.requirements.map(item => item.id));
    const plain = await loadRequirementCatalog(file);
    assert.equal(plain.requirements[0].product.evolution, product === "sheet" ? true : undefined);
  }
});

test("Ordinary Evolution product names keep Stage 1 unknown-dependency validation", async () => {
  await withYaml(JSON.stringify({ id: "ROOT", name: "Pet Evolution Tracker - Stage 1", type: "FOLDER", children: [
    { id: "REQ-99", name: "Current feature", type: "ATOMIC", dependencies: ["TYPO-OLD-ID"], description: "Display records." },
  ] }), async file => {
    await assert.rejects(loadRequirementCatalog(file), /Unknown dependency TYPO-OLD-ID/);
  });
});

test("Evolution increments still reject cycles between current requirements", async () => {
  await withYaml(JSON.stringify({ id: "ROOT", name: "Inventory - Evolution", type: "FOLDER", children: [
    { id: "REQ-3", name: "A", type: "ATOMIC", dependencies: ["REQ-1", "REQ-4"], description: "A." },
    { id: "REQ-4", name: "B", type: "ATOMIC", dependencies: ["REQ-3"], description: "B." },
  ] }), async file => {
    await assert.rejects(loadRequirementCatalog(file), /Dependency cycle/);
  });
});

test("Catalog rejects duplicate identifiers", async () => {
  await withYaml(
    `id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: []\n    description: One\n  - id: X\n    name: Two\n    type: ATOMIC\n    dependencies: []\n    description: Two\n`,
    async (file) => {
      await assert.rejects(loadRequirementCatalog(file), /Duplicate requirement id: X/);
    },
  );
});

test("Catalog rejects unknown dependencies", async () => {
  await withYaml(
    `id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: [MISSING]\n    description: One\n`,
    async (file) => {
      await assert.rejects(loadRequirementCatalog(file), /Unknown dependency MISSING/);
    },
  );
});

test("Stage 1 still rejects dependencies because no earlier-stage context exists", async () => {
  await withYaml(
    `id: ROOT
name: 库存工作台 - 第 1 阶段
type: FOLDER
dependencies: []
children:
  - id: X
    name: One
    type: ATOMIC
    dependencies: [MISSING]
    description: One
`,
    async (file) => {
      await assert.rejects(loadRequirementCatalog(file), /Unknown dependency MISSING/);
    },
  );
});

test("Catalog rejects dependency cycles", async () => {
  await withYaml(
    `id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: [Y]\n    description: One\n  - id: Y\n    name: Two\n    type: ATOMIC\n    dependencies: [X]\n    description: Two\n`,
    async (file) => {
      await assert.rejects(loadRequirementCatalog(file), /Dependency cycle/);
    },
  );
});

test("Catalog reads only the explicitly selected YAML file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shallow-catalog-"));
  try {
    const selected = join(directory, "requirements.yaml");
    await writeFile(
      selected,
      "id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren: []\n",
    );
    await writeFile(join(directory, "sibling.yaml"), "not: [valid");

    const catalog = await loadRequirementCatalog(selected);

    assert.deepEqual(catalog.requirements, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Catalog keeps original folder dependencies, explicit scenario IDs and empty folders for ARC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shallow-catalog-tree-"));
  try {
    const path = join(directory, "requirements.yaml");
    await writeFile(path, JSON.stringify({ id: "ROOT", name: "Root", type: "ROOT", children: [
      { id: "EMPTY", name: "Empty", type: "FOLDER", scenarios: [{ id: "S-EMPTY", name: "Folder scenario", steps: [] }] },
      { id: "BASE", name: "Base", type: "FOLDER", children: [{ id: "A", name: "A", type: "ATOMIC" }] },
      { id: "FOLLOW", name: "Follow", type: "FOLDER", dependencies: ["BASE"], visual_reference: ["reference/folder.png"],
        children: [{ id: "B", name: "B", type: "ATOMIC", scenarios: [{ id: "S-B", name: "Custom", steps: [] }] }] },
    ] }));
    const catalog = await loadRequirementCatalog(path);
    assert.deepEqual(catalog.tree.children.map((node) => node.id), ["EMPTY", "BASE", "FOLLOW"]);
    assert.deepEqual(catalog.tree.children[2].dependencies, ["BASE"]);
    assert.deepEqual(catalog.tree.children[2].visual_reference, ["reference/folder.png"]);
    assert.equal(catalog.tree.children[2].children[0].scenarios[0].id, "S-B");
    assert.deepEqual(catalog.requirements.find((node) => node.id === "B")?.dependencyIds, ["A"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Catalog expands folder dependencies and inherits ancestor prerequisites", async () => {
  const catalog = await loadRequirementCatalog(resolve("data/official-competition/hackathon--github/requirements.yaml"));
  const atomicIds = new Set(catalog.requirements.map((item) => item.id));
  for (const item of catalog.requirements) {
    assert.ok(item.dependencyIds.every((id) => atomicIds.has(id)), item.id);
  }
  const folderLeaves = catalog.requirements.filter((item) => item.folderPath.includes("REQ-4-3")).map((item) => item.id);
  assert.ok(folderLeaves.length > 0);
  const dependents = catalog.requirements.filter((item) => item.folderPath.includes("REQ-6-2"));
  assert.ok(dependents.length > 0);
  for (const dependent of dependents) {
    assert.ok(folderLeaves.every((id) => dependent.dependencyIds.includes(id)));
  }
});

test("Catalog drops vacuous self and enclosing-folder dependencies", async () => {
  await withYaml("id: ROOT\nname: Root\ntype: ROOT\nchildren:\n  - id: AREA\n    name: Area\n    type: FOLDER\n    children:\n      - id: X\n        name: One\n        type: ATOMIC\n        dependencies: [AREA, X]\n", async (file) => {
    const catalog = await loadRequirementCatalog(file);
    assert.deepEqual(catalog.requirements[0].dependencyIds, []);
  });
});

test("Catalog keeps cross-subtree ordering while ignoring a folder dependency on its own ancestor", async () => {
  const yaml = [
    "id: ROOT",
    "name: Root",
    "type: ROOT",
    "children:",
    "  - id: P",
    "    name: Parent",
    "    type: FOLDER",
    "    dependencies: []",
    "    children:",
    "      - id: A",
    "        name: First",
    "        type: ATOMIC",
    "        dependencies: []",
    "      - id: F",
    "        name: Nested",
    "        type: FOLDER",
    "        dependencies: [P]",
    "        children:",
    "          - id: B",
    "            name: Second",
    "            type: ATOMIC",
    "            dependencies: [A]",
  ].join("\n");
  await withYaml(`${yaml}\n`, async (file) => {
    const catalog = await loadRequirementCatalog(file);
    const byId = new Map(catalog.requirements.map((item) => [item.id, item]));
    assert.deepEqual(byId.get("A")?.dependencyIds, []);
    assert.deepEqual(byId.get("B")?.dependencyIds, ["A"]);
  });
});

test("Catalog parses top-level seed data into the product context", async () => {
  await withYaml(
    `id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren:\n  - id: X\n    name: One\n    type: ATOMIC\n    dependencies: []\n    description: One\ndata:\n  - category: Account Seed Data\n    items:\n      - Verified accounts can sign in by username or verified email.\n      - Recovery displays the fixed verification code `+"`123456`"+`.\n  - category: Repository Seed Data\n    items:\n      - A public organization with one public repository.\n`,
    async (file) => {
      const catalog = await loadRequirementCatalog(file);
      assert.deepEqual(catalog.requirements[0].product.seedData, [
        {
          category: "Account Seed Data",
          items: [
            "Verified accounts can sign in by username or verified email.",
            "Recovery displays the fixed verification code `123456`.",
          ],
        },
        {
          category: "Repository Seed Data",
          items: ["A public organization with one public repository."],
        },
      ]);
    },
  );
});

test("Catalog reads seed data from requirement files", async () => {
  const yaml = [
    "id: ROOT",
    "name: Root",
    "type: FOLDER",
    "dependencies: []",
    "data:",
    "  - category: Account and Permission Seed Data",
    "    items:",
    "      - \"verified account with nickname Demo User\"",
    "children:",
    "  - id: REQ-1",
    "    name: One",
    "    type: ATOMIC",
    "    dependencies: []",
    "    description: Do it.",
  ].join("\n");
  await withYaml(`${yaml}\n`, async (file) => {
    const catalog = await loadRequirementCatalog(file);
    const { seedData } = catalog.requirements[0].product;
    assert.equal(seedData.length, 1);
    assert.equal(seedData[0].category, "Account and Permission Seed Data");
    assert.deepEqual(seedData[0].items, ["verified account with nickname Demo User"]);
  });
});

test("Catalog rejects malformed seed data", async () => {
  await withYaml(
    `id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren: []\ndata:\n  - category: 42\n    items: []\n`,
    async (file) => {
      await assert.rejects(loadRequirementCatalog(file), /root\.data\[0\]\.category must be a string/);
    },
  );
  await withYaml(
    `id: ROOT\nname: Root\ntype: FOLDER\ndependencies: []\nchildren: []\ndata: not-a-list\n`,
    async (file) => {
      await assert.rejects(loadRequirementCatalog(file), /root\.data must be an array/);
    },
  );
});

test("Catalog extracts verbatim Seed data and Seed values declarations from requirement evidence", async () => {
  const yaml = [
    "id: ROOT",
    "name: Root",
    "type: ROOT",
    "children:",
    "  - id: AREA",
    "    name: Area",
    "    type: FOLDER",
    "    dependencies: []",
    "    description: 'Area. Seed data: verified account with nickname \"Demo User\", email \"demo@example.com\", and password \"Password123!\".'",
    "    children:",
    "      - id: A",
    "        name: First",
    "        type: ATOMIC",
    "        dependencies: []",
    "        description: 'Create a shelf. Reference image: ![image](./reference/create.png) Seed data: shelf \"Shelf 4.3.1\".'",
    "      - id: B",
    "        name: Second",
    "        type: ATOMIC",
    "        dependencies: []",
    "        description: 'Open a workbook. Seed values: workbook \"Q3 Sales\".'",
    "        scenarios:",
    "          - name: Open seeded workbook",
    "            steps:",
    "              - keyword: GIVEN",
    "                content: 'The evaluation seed contains the seeded workbook \"Q3 Sales\", worksheet \"Sheet1\", and cell A1 value \"Region\". The visitor opens the home page.'",
    "  - id: OTHER",
    "    name: Other",
    "    type: FOLDER",
    "    dependencies: []",
    "    children:",
    "      - id: C",
    "        name: Third",
    "        type: ATOMIC",
    "        dependencies: []",
    "        description: 'Delete a shelf. Seed data: deletable shelf \"Shelf 4.4.1\". Seed data: account \"backup@example.com\".'",
  ].join("\n");
  await withYaml(`${yaml}\n`, async (file) => {
    const catalog = await loadRequirementCatalog(file);
    const byId = new Map(catalog.requirements.map((item) => [item.id, item]));
    assert.deepEqual(byId.get("A")?.seedDeclarations, [
      'Seed data: verified account with nickname "Demo User", email "demo@example.com", and password "Password123!"',
      'Seed data: shelf "Shelf 4.3.1"',
    ]);
    assert.deepEqual(byId.get("B")?.seedDeclarations, [
      'Seed data: verified account with nickname "Demo User", email "demo@example.com", and password "Password123!"',
      'Seed values: workbook "Q3 Sales"',
      'The evaluation seed contains the seeded workbook "Q3 Sales", worksheet "Sheet1", and cell A1 value "Region"',
    ]);
    assert.deepEqual(byId.get("C")?.seedDeclarations, [
      'Seed data: deletable shelf "Shelf 4.4.1"',
      'Seed data: account "backup@example.com"',
    ]);
  });
});

test("Catalog preserves modern provisioned records and GIVEN facts without seeding creation targets", async () => {
  const declared = 'The system pre-provisions account `reader` with email `reader@example.test` and password `Valid-password-123!`.';
  const setup = 'Test setup pre-provisions repository `docs` with file `a.b.md` and content `Hello. And goodbye!`.';
  const given = 'Public repository `docs` has an Open issue titled `Read and write`.';
  await withYaml(JSON.stringify({ id: "ROOT", name: "App", type: "FOLDER", children: [
    { id: "A", name: "Read", type: "ATOMIC", description: declared, scenarios: [{ name: "Read", steps: [
      { keyword: "GIVEN", content: setup }, { keyword: "AND", content: given },
      { keyword: "WHEN", content: 'Create repository `new-docs`.' }, { keyword: "THEN", content: 'Repository `new-docs` exists.' },
    ] }] },
    { id: "B", name: "Create", type: "ATOMIC", scenarios: [{ name: "Create", steps: [
      { keyword: "GIVEN", content: 'The username `new-user` and email `new-user@example.test` are not registered.' },
      { keyword: "WHEN", content: 'Create account `new-user`.' },
    ] }] },
  ] }), async file => {
    const catalog = await loadRequirementCatalog(file);
    assert.deepEqual(catalog.requirements[0].seedDeclarations, [declared, setup, given]);
    assert.deepEqual(catalog.requirements[1].seedDeclarations, []);
  });
});

test("Bundled competition seeds and legacy Seed data declarations remain extractable", async () => {
  const github = await loadRequirementCatalog(resolve("data/official-competition/hackathon--github/requirements.yaml"));
  assert.equal(github.requirements.length, 47);
  // Registration creates unused names; other GitHub atomics have existing fixtures.
  assert.deepEqual(github.requirements.filter(item => !item.seedDeclarations.length).map(item => item.id), ["REQ-1-1-1"]);
  assert.ok(github.requirements.find(item => item.id === "REQ-1-1-2")!.seedDeclarations.some(value => value.includes('username `alice-dev`')));
  assert.ok(github.requirements.find(item => item.id === "REQ-5-2-2")!.seedDeclarations.some(value => value.includes('`Original issue title`')));
  for (const stage of [1, 2, 3]) {
    const catalog = await loadRequirementCatalog(resolve(`data/official-competition/hackathon--github-stage-${stage}/requirements.yaml`));
    assert.ok(catalog.requirements.filter(item => item.id !== "REQ-1-1-1").every(item => item.seedDeclarations.length > 0));
  }

  const sheet = await loadRequirementCatalog(resolve("data/official-competition/hackathon--sheet/requirements.yaml"));
  assert.equal(sheet.requirements.length, 24);
  assert.ok(sheet.requirements.every((item) => item.seedDeclarations.some((value) => value.startsWith("The evaluation seed contains"))));
  assert.ok(sheet.requirements[0].seedDeclarations.includes(
    "The evaluation seed contains the seeded workbook `Q3 Sales`, worksheet `Sheet1`, and cell A1 value `Region`",
  ));
  assert.ok(sheet.requirements.some((item) => item.seedDeclarations.includes(
    "The evaluation seed contains the seeded workbook `Q3 Sales`, cells `A1=2`, `B1=3`, and formulas `=A1+B1` and `=C1*2`",
  )));

  const keep = await loadRequirementCatalog(resolve("data/keep/requirements.yaml"));
  assert.ok(keep.requirements.some((item) => item.seedDeclarations.includes(
    'Seed data: pinned note "Sprint goals" and regular note "Groceries"',
  )));
  const bookstack = await loadRequirementCatalog(resolve("data/bookstack/requirements.yaml"));
  assert.ok(bookstack.requirements.some((item) => item.seedDeclarations.includes('Seed data: shelf "Shelf 4.3.1"')));
});

async function withYaml(
  contents: string,
  callback: (file: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "shallow-catalog-"));
  const file = join(directory, "requirements.yaml");
  try {
    await writeFile(file, contents);
    await callback(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
