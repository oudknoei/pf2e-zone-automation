import assert from "node:assert/strict";
import test from "node:test";

const createdFolders = [];
const journals = [];
let journalCreateData = null;

globalThis.foundry = { utils: {} };
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 },
  JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 }
};
globalThis.game = {
  system: { id: "pf2e" },
  user: { id: "gm", name: "GM", isGM: true },
  users: new Map([["gm", { id: "gm", name: "GM", active: true, isGM: true }]]),
  folders: createdFolders,
  journal: journals
};
globalThis.CONFIG = {
  Folder: {
    documentClass: {
      async create(data) {
        const folder = {
          id: "journal-folder",
          ...data,
          getFlag(scope, key) { return data.flags?.[scope]?.[key]; }
        };
        createdFolders.push(folder);
        return folder;
      }
    }
  },
  JournalEntry: {
    documentClass: {
      async create(data) {
        journalCreateData = data;
        const journal = {
          id: "zone-library",
          uuid: "JournalEntry.zone-library",
          ...data,
          pages: [],
          getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
          async update(changes) { Object.assign(this, changes); },
          async createEmbeddedDocuments(_type, pages) {
            const created = pages.map((page, index) => ({
              id: `page-${index}`,
              ...page,
              getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
              async update(changes) { Object.assign(this, changes); }
            }));
            this.pages.push(...created);
            return created;
          }
        };
        journals.push(journal);
        return journal;
      }
    }
  }
};

const { handleWorkerRequest } = await import("../scripts/worker.js");

test("the shared zone library creates its Journal in the PF2e Zone Automation folder", async () => {
  const result = await handleWorkerRequest({ protocol: 1, action: "library-list", requesterUserId: "gm" });
  assert.equal(result.ok, true);
  assert.equal(createdFolders.length, 1);
  assert.equal(createdFolders[0].name, "PF2e Zone Automation");
  assert.equal(createdFolders[0].type, "JournalEntry");
  assert.equal(journalCreateData.folder, createdFolders[0].id);
  assert.equal(journals[0].folder, createdFolders[0].id);
  assert.equal(journals[0].pages.length, 1);
});