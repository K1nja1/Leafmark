// server.js

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

/* --------------------------------------------------
   BISAC / genre helpers
   -------------------------------------------------- */

// Parse a CSV row into [code, label]
const parseBisacCsvRow = (line = '') => {
  const comma = line.indexOf(',');
  if (comma === -1) return ['', ''];

  return [
    line.slice(0, comma).replace(/^"|"$/g, ''),
    line.slice(comma + 1).replace(/^"|"$/g, '')
  ];
};

// Normalize text before comparing BISAC labels
function normaliseBisacText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Deduplicate while preserving order
const unique = (values = []) =>
  [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];

// Example: this is the in-memory BISAC map.
// In the real file, this is typically loaded from a CSV or seed file.
const BISAC_BY_CODE = new Map([
  ['FIC009000', 'Fiction / Fantasy / General'],
  ['FIC013000', 'Fiction / Science Fiction / General'],
  ['FIC022000', 'Fiction / Mystery / General'],
  ['FIC026000', 'Fiction / Romance / General'],
]);

const BISAC_ENTRIES = [...BISAC_BY_CODE].map(([code, category]) => {
  const details = category
    .split('/')
    .map((part) => part.trim())
    .slice(1)
    .filter((part) => part.toLowerCase() !== 'general');

  const aliases = [details.join(' ')];

  if (details.length === 1 && category.startsWith('Fiction /')) {
    aliases.push(details[0]);
  }

  return {
    code,
    category,
    aliases: [
      ...new Set(
        aliases
          .map(normaliseBisacText)
          .filter((alias) => alias.length >= 4)
      )
    ]
  };
});

const BISAC_GENRE_RULES = [
  { code: 'FIC009000', terms: ['fantasy', 'magic', 'dragons', 'witchcraft', 'wizards'] },
  { code: 'FIC013000', terms: ['science fiction', 'sci fi', 'space', 'future'] },
  { code: 'FIC022000', terms: ['mystery', 'detective', 'crime', 'thriller'] },
  { code: 'FIC026000', terms: ['romance', 'love story', 'relationship'] }
];

const BISAC_SYNONYM_RULES = [
  { code: 'FIC009000', terms: ['fantasy', 'magic', 'dragons', 'witchcraft', 'wizards'] }
];

function normaliseGenres(values = []) {
  const labels = unique(values).map(normaliseBisacText);

  const directMatches = BISAC_ENTRIES
    .filter(({ aliases }) =>
      aliases.some((alias) =>
        labels.some((label) => {
          const aliasWords = alias.split(' ');
          const labelWords = new Set(label.split(' '));
          return label === alias || (
            aliasWords.length > 1 &&
            aliasWords.every((word) => labelWords.has(word))
          );
        })
      )
    )
    .map(({ code }) => code);

  const synonymMatches = BISAC_SYNONYM_RULES
    .filter(({ terms }) =>
      terms.some((term) =>
        labels.some((label) => label.includes(normaliseBisacText(term)))
      )
    )
    .map(({ code }) => code);

  return unique([...directMatches, ...synonymMatches]);
}

function genreLabels(codes = []) {
  return codes
    .map((code) => BISAC_BY_CODE.get(code))
    .filter(Boolean)
    .map((label) => label.replace(/^Fiction \/ /, '').replace(/ \/ General$/, ''));
}

function genreSearchTerm(code) {
  const genreRule = BISAC_GENRE_RULES.find((item) => item.code === code);
  if (genreRule) return genreRule.terms[0];

  const synonymRule = BISAC_SYNONYM_RULES.find((item) => item.code === code);
  if (synonymRule) return synonymRule.terms[0];

  const entry = BISAC_ENTRIES.find((item) => item.code === code);
  return entry?.aliases[0] || '';
}

/* --------------------------------------------------
   Open Library / recommendation helpers
   -------------------------------------------------- */

function openLibraryBook(book) {
  const rawSubjects = unique(book.subject || []).slice(0, 12);
  const normalizedGenres = normaliseGenres(rawSubjects);

  return {
    id: `ol:${book.key}`,
    title: book.title || 'Untitled',
    author: Array.isArray(book.author_name) ? book.author_name[0] : 'Unknown author',
    year: book.first_publish_year || null,
    genres: normalizedGenres,
    subjects: rawSubjects
  };
}

/* --------------------------------------------------
   Routes
   -------------------------------------------------- */

app.get('/api/books/search', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'A search query is required.' });
  }

  try {
    const response = await axios.get('https://openlibrary.org/search.json', {
      params: { q: query, limit: 10 }
    });

    const books = (response.data.docs || []).map(openLibraryBook);

    return res.json({ books });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to search books.',
      details: error.message
    });
  }
});

app.get('/api/genres', (req, res) => {
  const query = normaliseBisacText(req.query.q);

  const genres = BISAC_ENTRIES.filter(({ code, category }) => {
    if (!query) return true;
    return normaliseBisacText(`${code} ${category}`).includes(query);
  });

  return res.json({ genres: genres.map(({ code, category }) => ({ code, category })) });
});

app.post('/api/books/recommendations', async (req, res) => {
  const chosen = req.body.book;

  if (!chosen?.title) {
    return res.status(400).json({ error: 'A book is required.' });
  }

  try {
    const genre = chosen.genre || '';
    const searchTerm = genreSearchTerm(genre) || normaliseBisacText(genre);

    const response = await axios.get('https://openlibrary.org/search.json', {
      params: {
        q: searchTerm,
        limit: 5
      }
    });

    const books = (response.data.docs || []).slice(0, 5).map(openLibraryBook);

    return res.json({ recommendations: books });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch recommendations.',
      details: error.message
    });
  }
});

module.exports = app;
