import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { normalizeArcRequirements } from "../src/experiments/requirements.js";

function input() {
  return { id: "ROOT", name: "Product", description: { text: "Product context." }, children: [{
    id: "REQ-1", name: "Lifecycle", description: { text: "Initial data stays in its original scope.",
      image: [{ id: "IMG-1", reference: "reference/home.png", page: "home" }] }, children: [],
    scenarios: [{ id: "SCN-1", name: "Change state", steps: [
      { id: "STEP-1", Given: 'Seed prerequisites:\n- account: {"name": "张三", "active": true}\n',
        When: "Create {{literal}} through the UI.", Then: "The new object is visible.",
        references: ["\\ref[image](IMG-1)", "\\ref[requirement](REQ-1)"] },
      { id: "STEP-2", And: "Its name remains {{literal}}.", But: "No duplicate exists." },
    ] }],
  }] };
}

test("ARC mapping retains multi-clause step boundaries, references, images and literal seed text", () => {
  const original = input();
  const converted = normalizeArcRequirements(JSON.stringify(original));
  const tree = parse(converted.yaml);
  assert.deepEqual(tree.children[0].scenarios[0].steps, [
    { keyword: "GIVEN", content: original.children[0].scenarios[0].steps[0].Given },
    { keyword: "WHEN", content: "Create {{literal}} through the UI." },
    { keyword: "THEN", content: "The new object is visible." },
    { keyword: "AND", content: "Its name remains {{literal}}." },
    { keyword: "BUT", content: "No duplicate exists." },
  ]);
  assert.deepEqual(converted.sourceMap, {
    images: [{ requirementId: "REQ-1", id: "IMG-1", reference: "reference/home.png", page: "home" }],
    steps: [
      { requirementId: "REQ-1", scenarioId: "SCN-1", stepId: "STEP-1", sourceStepIndex: 0,
        normalizedStepIndices: [0, 1, 2], references: ["\\ref[image](IMG-1)", "\\ref[requirement](REQ-1)"] },
      { requirementId: "REQ-1", scenarioId: "SCN-1", stepId: "STEP-2", sourceStepIndex: 1,
        normalizedStepIndices: [3, 4], references: [] },
    ],
  });
  assert.deepEqual(tree.children[0].dependencies, []);
  assert.equal(tree.data, undefined);
  assert.equal(normalizeArcRequirements(converted.yaml).yaml, converted.yaml);
  assert.equal(normalizeArcRequirements(converted.yaml).sourceMap, null);
});

test("ARC conversion rejects unknown nested fields rather than silently discarding input", () => {
  const original = input();
  const objects = [original, original.description, original.children[0], original.children[0].description,
    original.children[0].description.image[0], original.children[0].scenarios[0], original.children[0].scenarios[0].steps[0]];
  for (const object of objects) {
    Object.assign(object, { unsupported: "An obligation must not disappear." });
    assert.throws(() => normalizeArcRequirements(JSON.stringify(original)), /Unsupported ARC .*field unsupported/);
    delete (object as Record<string, unknown>).unsupported;
  }
});

test("ARC conversion rejects ambiguous identities, malformed clauses and folder-owned scenarios", () => {
  const edits: Array<(tree: ReturnType<typeof input>) => void> = [
    tree => { tree.children.push(structuredClone(tree.children[0])); },
    tree => { tree.children[0].scenarios.push(structuredClone(tree.children[0].scenarios[0])); },
    tree => { tree.children[0].scenarios[0].steps[1].id = "STEP-1"; },
    tree => { tree.children[0].scenarios[0].id = ""; },
    tree => { tree.children[0].scenarios[0].steps[0].id = ""; },
    tree => { Object.assign(tree.children[0].scenarios[0].steps[0], { references: [42] }); },
    tree => { Object.assign(tree.children[0].scenarios[0].steps[0], { Then: 42 }); },
    tree => { Object.assign(tree.children[0].scenarios[0], { steps: [{ id: "EMPTY" }] }); },
    tree => { Object.assign(tree.children[0], { children: [input().children[0]] }); },
    tree => { Object.assign(tree, { scenarios: tree.children[0].scenarios }); },
  ];
  for (const edit of edits) {
    const tree = input(); edit(tree);
    assert.throws(() => normalizeArcRequirements(JSON.stringify(tree)), /ARC/);
  }
  for (const value of [null, [], "text"]) assert.throws(() => normalizeArcRequirements(JSON.stringify(value)), /ARC/);
});
