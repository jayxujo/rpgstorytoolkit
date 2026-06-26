import type { Project } from '../types';

export const DEFAULT_PROJECT_NAME = 'My Story';

// ── Lexical rich-text helpers (kept tiny + dependency-free) ─────────────────
const txt = (text: string, bold = false) => ({
  type: 'text',
  text,
  format: bold ? 1 : 0,
  detail: 0,
  mode: 'normal',
  style: '',
  version: 1,
});
const para = (...children: any[]) => ({
  type: 'paragraph',
  children: children.length ? children : [txt('')],
  format: '',
  indent: 0,
  version: 1,
  direction: 'ltr',
});
const heading = (tag: 'h1' | 'h2' | 'h3', text: string) => ({
  type: 'heading',
  tag,
  children: [txt(text)],
  format: '',
  indent: 0,
  version: 1,
  direction: 'ltr',
});
const richDoc = (children: any[]) =>
  JSON.stringify({
    root: { type: 'root', children, format: '', indent: 0, version: 1, direction: 'ltr' },
  });

// Starter content for a brand-new project (used by both web and the desktop vault),
// so a fresh project shows off what the toolkit can do instead of being empty.
export function createSeedProject(name: string = DEFAULT_PROJECT_NAME): Project {
  const tutorialDocId = crypto.randomUUID();
  const chapterDocId = crypto.randomUUID();

  const charactersId = crypto.randomUUID();
  const locationsId = crypto.randomUUID();
  const itemsId = crypto.randomUUID();

  // Record ids referenced by entity links + conditions (rows are referenced by id).
  const ariaRowId = crypto.randomUUID();
  const theronRowId = crypto.randomUUID();
  const veskRowId = crypto.randomUUID();
  const emberfallRowId = crypto.randomUUID();
  const cloakRowId = crypto.randomUUID();

  // Rich, formatted tutorial (headings + bold). `content` mirrors it as plain
  // text for search/export; there are no entity links here so exact offset
  // alignment is not needed.
  const tutorialRich = richDoc([
    heading('h1', 'Welcome to RPG Story Toolkit'),
    para(txt('This short guide walks through what you can do. Delete it whenever you are ready to focus on your own story.')),

    heading('h2', 'Documents'),
    para(
      txt('Write your story, lore, and notes as documents. Use the '),
      txt('Documents', true),
      txt(' panel on the left to add documents and organize them into folders. This guide lives in the Tutorial folder, and your story begins in the Story folder.'),
    ),

    heading('h2', 'Database'),
    para(
      txt('The '),
      txt('Database', true),
      txt(' panel holds your structured game data as tables. Each table (for example Characters) has records, and each record has fields you define. Take a look at the Characters table, plus the Locations and Items tables grouped inside the World folder.'),
    ),

    heading('h2', 'Linking text to records'),
    para(
      txt('Select any text in a document, or type a forward slash, to link it to a record in one of your tables. You can link items, objects, people, places, and more. '),
      txt('Linked text shows the record’s name and stays connected to it', true),
      txt(', so if you rename the record your writing updates everywhere it is linked.'),
    ),

    heading('h2', 'Conditions'),
    para(
      txt('Conditions map your own fields (like '),
      txt('Stage', true),
      txt(' and '),
      txt('Interaction', true),
      txt(') to a result, such as a line of text, a value, or a record’s column value. This helps with branching and sequencing in your game. Open the Conditions panel on the left to see the example Dialogue condition, or create your own.'),
    ),

    heading('h2', 'Assets'),
    para(txt('Attach images and files to a record, such as a character portrait or a map image. Everything you upload shows up in the Assets panel.')),

    heading('h2', 'Timeline'),
    para(txt('Open Tools, then Timeline, to arrange your documents and record pins across a set of beats. You can rename each section to match your acts, chapters, or quests.')),

    heading('h2', 'World Map'),
    para(txt('Open Tools, then World Map, to create a world, set a map image, and place pins for documents and records directly on the map.')),

    heading('h2', 'Publishing a wiki'),
    para(txt('On the web app you can publish a clean, read only wiki of your project to share with players or your team.')),

    heading('h2', 'Moving your project'),
    para(
      txt('Use '),
      txt('File', true),
      txt(', then '),
      txt('Export project', true),
      txt(', to save a single file you can import on the other version of the app (desktop or web), with all of your assets included.'),
    ),

    para(txt('That is the tour. Have fun building your world.')),
  ]);

  const tutorialContent = [
    'Welcome to RPG Story Toolkit',
    '',
    'This short guide walks through what you can do. Delete it whenever you are ready to focus on your own story.',
    '',
    'Documents',
    'Write your story, lore, and notes as documents. Use the Documents panel on the left to add documents and organize them into folders. This guide lives in the Tutorial folder, and your story begins in the Story folder.',
    '',
    'Database',
    'The Database panel holds your structured game data as tables. Each table (for example Characters) has records, and each record has fields you define. Take a look at the Characters table, plus the Locations and Items tables grouped inside the World folder.',
    '',
    'Linking text to records',
    'Select any text in a document, or type a forward slash, to link it to a record in one of your tables. You can link items, objects, people, places, and more. Linked text shows the record’s name and stays connected to it, so if you rename the record your writing updates everywhere it is linked.',
    '',
    'Conditions',
    'Conditions map your own fields (like Stage and Interaction) to a result, such as a line of text, a value, or a record’s column value. This helps with branching and sequencing in your game. Open the Conditions panel on the left to see the example Dialogue condition, or create your own.',
    '',
    'Assets',
    'Attach images and files to a record, such as a character portrait or a map image. Everything you upload shows up in the Assets panel.',
    '',
    'Timeline',
    'Open Tools, then Timeline, to arrange your documents and record pins across a set of beats. You can rename each section to match your acts, chapters, or quests.',
    '',
    'World Map',
    'Open Tools, then World Map, to create a world, set a map image, and place pins for documents and records directly on the map.',
    '',
    'Publishing a wiki',
    'On the web app you can publish a clean, read only wiki of your project to share with players or your team.',
    '',
    'Moving your project',
    'Use File, then Export project, to save a single file you can import on the other version of the app (desktop or web), with all of your assets included.',
    '',
    'That is the tour. Have fun building your world.',
  ].join('\n');

  const chapterContent = [
    'Chapter 1: The Road to Emberfall',
    '',
    'The road climbed for hours before the trees gave way to open sky. Far below, the lights of Emberfall flickered against the dusk.',
    '',
    'Aria pulled her cloak tighter and pressed on. Theron, the old ranger, walked a few steps behind, one hand never far from his blade.',
    '',
    '"We should reach the gate before nightfall," Aria said.',
    '',
    '"Stay close. These woods are not as empty as they look," Theron replied.',
    '',
    'By the time they crossed the ridge, the first stars had appeared, and the real journey had only begun.',
  ].join('\n');

  const chapterRich = richDoc([
    heading('h1', 'Chapter 1: The Road to Emberfall'),
    para(txt('The road climbed for hours before the trees gave way to open sky. Far below, the lights of Emberfall flickered against the dusk.')),
    para(txt('Aria pulled her cloak tighter and pressed on. Theron, the old ranger, walked a few steps behind, one hand never far from his blade.')),
    para(txt('"We should reach the gate before nightfall," Aria said.')),
    para(txt('"Stay close. These woods are not as empty as they look," Theron replied.')),
    para(txt('By the time they crossed the ridge, the first stars had appeared, and the real journey had only begun.')),
  ]);

  // Demo entity links wrap the *nouns* in the prose (characters, a location, an
  // item) so they link to records in the tables. (Lexical joins blocks with "\n\n",
  // which chapterContent mirrors, so indexOf offsets align.) `needle` locates a
  // unique span and the link wraps its first `wordLen` characters.
  const ariaQuote = 'We should reach the gate before nightfall,';
  const theronQuote = 'Stay close. These woods are not as empty as they look,';
  const mkLink = (collectionId: string, entityId: string, needle: string, wordLen: number) => {
    const start = chapterContent.indexOf(needle);
    return start < 0 ? null : { id: crypto.randomUUID(), docId: chapterDocId, collectionId, entityId, start, end: start + wordLen };
  };
  const chapterEntityLinks = [
    mkLink(charactersId, ariaRowId, 'Aria pulled', 4),       // "Aria"
    mkLink(itemsId, cloakRowId, 'cloak', 5),                  // "cloak"
    mkLink(charactersId, theronRowId, 'Theron, the old', 6),  // "Theron"
    mkLink(locationsId, emberfallRowId, 'Emberfall flickered', 9), // "Emberfall"
  ].filter((l): l is NonNullable<typeof l> => l !== null);

  return {
    id: crypto.randomUUID(),
    name,
    documents: [
      {
        id: tutorialDocId,
        title: 'Getting started',
        folderPath: ['Tutorial'],
        content: tutorialContent,
        richContent: tutorialRich,
        entityLinks: [],
      },
      {
        // No colon in the title: a "Folder: Name" colon would be parsed into a
        // phantom folder. The "Chapter 1" framing lives in the document heading.
        id: chapterDocId,
        title: 'The Road to Emberfall',
        folderPath: ['Story'],
        content: chapterContent,
        richContent: chapterRich,
        entityLinks: chapterEntityLinks,
      },
    ],
    collections: [
      {
        id: charactersId,
        name: 'Characters',
        folderPath: [],
        kind: 'generic',
        assetsEnabled: true,
        color: '#4f8cff',
        schema: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
          { id: 'role', label: 'Role', type: 'string' },
          { id: 'description', label: 'Description', type: 'text' },
        ],
        rows: [
          {
            id: ariaRowId,
            values: { id: 'ARIA', name: 'Aria', role: 'Protagonist', description: 'A traveler bound for Emberfall, quick witted and quicker on her feet.' },
            assets: [],
          },
          {
            id: theronRowId,
            values: { id: 'THERON', name: 'Theron', role: 'Ranger', description: 'A weathered guide who knows the Gloomwood better than anyone alive.' },
            assets: [],
          },
          {
            id: veskRowId,
            values: { id: 'VESK', name: 'Vesk', role: 'Antagonist', description: 'A shadow on the road whose plans for Emberfall are not yet clear.' },
            assets: [],
          },
        ],
      },
      {
        id: locationsId,
        name: 'Locations',
        folderPath: ['World'],
        kind: 'generic',
        assetsEnabled: true,
        color: '#22b07d',
        schema: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
          { id: 'type', label: 'Type', type: 'string' },
          { id: 'description', label: 'Description', type: 'text' },
        ],
        rows: [
          {
            id: emberfallRowId,
            values: { id: 'EMBERFALL', name: 'Emberfall', type: 'City', description: 'A walled city of lamplight and trade, built where three roads meet.' },
            assets: [],
          },
          {
            id: crypto.randomUUID(),
            values: { id: 'GLOOMWOOD', name: 'Gloomwood', type: 'Forest', description: 'A dense, old forest on the approach to Emberfall. Easy to enter, hard to leave.' },
            assets: [],
          },
        ],
      },
      {
        id: itemsId,
        name: 'Items',
        folderPath: ['World'],
        kind: 'generic',
        assetsEnabled: true,
        color: '#b070ff',
        schema: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
          { id: 'type', label: 'Type', type: 'string' },
          { id: 'description', label: 'Description', type: 'text' },
        ],
        rows: [
          {
            id: crypto.randomUUID(),
            values: { id: 'EMBER_BLADE', name: 'Ember Blade', type: 'Weapon', description: 'A short sword whose edge glows faintly warm, even in the cold.' },
            assets: [],
          },
          {
            id: cloakRowId,
            values: { id: 'TRAVELERS_CLOAK', name: "Traveler's Cloak", type: 'Apparel', description: 'A weathered wool cloak, warm against the mountain wind.' },
            assets: [],
          },
        ],
      },
    ],
    documentFolders: [['Tutorial'], ['Story']],
    collectionFolders: [['World']],
    datasets: [
      {
        id: 'dialogue',
        name: 'Dialogue',
        fieldDefs: [
          { id: 'STAGE', label: 'Stage', type: 'number', defaultValue: 1 },
          { id: 'INTERACTION', label: 'Interaction', type: 'number', defaultValue: 1 },
        ],
        entries: [
          {
            id: crypto.randomUUID(),
            subjectCollectionId: charactersId,
            subjectEntityId: ariaRowId,
            fields: { STAGE: 1, INTERACTION: 1 },
            result: { kind: 'text', value: ariaQuote },
          },
          {
            id: crypto.randomUUID(),
            subjectCollectionId: charactersId,
            subjectEntityId: theronRowId,
            fields: { STAGE: 1, INTERACTION: 2 },
            result: { kind: 'text', value: theronQuote },
          },
        ],
      },
    ],
    timelineLabels: [],
    worldMapDocPins: [],
    worldMapLabelPins: [],
    // Show the Assets and Dialogue trees in the sidebar by default for new projects.
    view: {
      uiShowAssetsTree: true,
      uiShowDialogueTree: true,
    },
  };
}
