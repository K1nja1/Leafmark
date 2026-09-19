require('dotenv').config();

const fs = require('fs');
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const OPEN_LIBRARY = 'https://openlibrary.org';
const googleKey = process.env.GOOGLE_BOOKS_API_KEY;
const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const jwtSecret = process.env.JWT_SECRET || 'development-only-secret-change-me';
const BISAC_PATH = path.join(__dirname, 'data', 'bisac.csv');

const BISAC_BY_CODE = new Map(
  fs.readFileSync(BISAC_PATH, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const comma = line.indexOf(',');
      return [
        line.slice(0, comma),
        line.slice(comma + 1).replace(/^"|"$/g, ''),
      ];
    })
);

const BISAC_GENRE_RULES = [
  { code: 'FIC009000', terms: ['fantasy', 'magic', 'dragons', 'witchcraft', 'wizards'] },
  { code: 'FIC028000', terms: ['science fiction', 'dystopian', 'space travel', 'time travel', 'cyberpunk'] },
  { code: 'FIC027000', terms: ['romance', 'love stories', 'romantic fiction'] },
  { code: 'FIC022000', terms: ['mystery', 'detective', 'crime fiction', 'whodunit'] },
  { code: 'FIC030000', terms: ['thriller', 'suspense'] },
  { code: 'FIC015000', terms: ['horror', 'ghost stories', 'supernatural horror'] },
  { code: 'FIC002000', terms: ['adventure', 'quests', 'survival stories'] },
  { code: 'FIC043000', terms: ['coming of age'] },
  { code: 'JUV035000', terms: ['school stories', 'school fiction'] },
  { code: 'FIC014000', terms: ['historical fiction', 'historical novels'] },
  { code: 'FIC019000', terms: ['literary fiction', 'literary novels'] },
];

app.use(express.json({ limit: '100kb' }));

const cover = (id) => (id ? `https://covers.openlibrary.org/b/id/${id}-M.jpg` : '');
const unique = (values = []) =>
  [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];

function normaliseGenres(values = []) {
  const labels = unique(values).map((value) => value.toLowerCase());
  return BISAC_GENRE_RULES.filter(({ terms }) =>
    terms.some((term) =>
      labels.some((label) => label.includes(term.toLowerCase()))
    )
  ).map(({ code }) => code);
}

function genreLabels(codes = []) {
  return codes
    .map((code) => BISAC_BY_CODE.get(code))
    .filter(Boolean)
    .map((label) => label.replace(/^Fiction \/ /, '').replace(/ \/ General$/, ''));
}

function genreSearchTerm(code) {
  const rule = BISAC_GENRE_RULES.find((item) => item.code === code);
  return rule?.terms[0] || '';
}

function openLibraryBook(book) {
  const rawSubjects = unique(book.subject).slice(0, 12);
  const normalizedGenres = normaliseGenres(rawSubjects);

  return {
    id: `ol:${book.key}`,
    title: book.title || 'Untitled',
    author: Array.isArray(book.author_name) && book.author_name.length ? book.author_name[0] : 'Unknown',
    cover: book.cover_i ? cover(book.cover_i) : '',
    description: '',
    source: 'openlibrary',
    normalizedGenres,
    subjects: genreLabels(normalizedGenres),
    averageRating: 0,
    ratingCount: 0,
    year: book.first_publish_year || null,
  };
}

function googleBook(item) {
  const info = item.volumeInfo || {};
  const rawSubjects = unique(info.categories).slice(0, 12);
  const normalizedGenres = normaliseGenres(rawSubjects);

  return {
    id: `gb:${item.id}`,
    title: info.title || 'Untitled',
    author: (info.authors || [])[0] || 'Unknown',
    cover: info.imageLinks?.thumbnail || '',
    description: info.description || '',
    source: 'googlebooks',
    normalizedGenres,
    subjects: genreLabels(normalizedGenres),
    averageRating: info.averageRating || 0,
    ratingCount: info.ratingsCount || 0,
    year: info.publishedDate ? new Date(info.publishedDate).getFullYear() : null,
  };
}

async function openSearch(query, limit = 20) {
  const url = new URL(`${OPEN_LIBRARY}/search.json`);
  url.search = new URLSearchParams({
    q: query,
    limit,
    fields: 'key,title,author_name,first_publish_year,cover_i,subject',
  }).toString();

  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.docs || []).map(openLibraryBook).slice(0, limit);
  } catch (error) {
    console.error('Open Library search failed:', error);
    return [];
  }
}

async function googleSearch(query, limit = 10, subjectOnly = false) {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('q', subjectOnly ? `subject:${query}` : query);
  url.searchParams.set('maxResults', String(Math.min(limit, 40)));

  if (googleKey) {
    url.searchParams.set('key', googleKey);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.items || []).map(googleBook).filter(Boolean).slice(0, limit);
  } catch (error) {
    console.error('Google Books search failed:', error);
    return [];
  }
}

function readerPopularity(book) {
  return book.ratingCount
    ? Math.log10(book.ratingCount + 1) * ((book.averageRating || 0) / 5)
    : 0;
}

async function catalogueSearch(query, limit = 20, subjectOnly = false) {
  const [open, google] = await Promise.all([
    openSearch(query, limit),
    googleSearch(query, Math.min(limit, 10), subjectOnly),
  ]);

  const interleaved = [];
  for (let index = 0; index < Math.max(open.length, google.length); index += 1) {
    if (open[index]) interleaved.push(open[index]);
    if (google[index]) interleaved.push(google[index]);
  }

  const merged = new Map();

  for (const book of interleaved) {
    const key = `${book.title.toLowerCase()}|${book.author.toLowerCase()}`;
    const existing = merged.get(key);

    if (existing) {
      existing.sources = unique([...existing.sources, book.source]);
      existing.normalizedGenres = unique([...existing.normalizedGenres, ...book.normalizedGenres]);
      existing.subjects = genreLabels(existing.normalizedGenres);

      if (book.ratingCount > existing.ratingCount) {
        existing.ratingCount = book.ratingCount;
        existing.averageRating = book.averageRating;
      }

      if (!existing.cover && book.cover) existing.cover = book.cover;
      if (!existing.description && book.description) existing.description = book.description;
    } else {
      merged.set(key, { ...book, sources: [book.source] });
    }
  }

  return [...merged.values()]
    .sort((a, b) => readerPopularity(b) - readerPopularity(a))
    .slice(0, limit);
}

function normaliseText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function score(candidate, chosen) {
  const selectedGenres = chosen.normalizedGenres || [];
  const genreOverlap = candidate.normalizedGenres.filter((genre) => selectedGenres.includes(genre)).length;
  const titleSimilarity = normaliseText(candidate.title).includes(normaliseText(chosen.title)) ? 1 : 0;
  const authorSimilarity = normaliseText(candidate.author).includes(normaliseText(chosen.author)) ? 1 : 0;

  return genreOverlap * 3 + titleSimilarity * 2 + authorSimilarity;
}

function isEditorialTitle(book) {
  return /\b(bibliography|reference|encyclopedia|handbook|textbook|study guide|literary criticism)\b/i.test(book.title);
}

function isSameSeries(candidate, chosen) {
  const words = chosen.title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 2);

  return words.length === 2 && candidate.title.toLowerCase().includes(words[0]) && candidate.title.toLowerCase().includes(words[1]);
}

function requireDatabase(req, res, next) {
  if (!db) {
    return res.status(503).json({
      error: 'Database is not configured yet. Add DATABASE_URL and run npm run db:migrate.',
    });
  }

  next();
}

function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Please sign in first.' });
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function userToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: '7d' });
}

app.get('/api/books/search', async (req, res) => {
  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'A search query is required.' });
  }

  try {
    const books = await catalogueSearch(query, 20);
    return res.json(books);
  } catch (error) {
    console.error('Book search failed:', error);
    return res.status(500).json({ error: 'Failed to search for books.' });
  }
});

app.post('/api/books/recommendations', async (req, res) => {
  const chosen = req.body.book;

  if (!chosen?.title) {
    return res.status(400).json({ error: 'A book is required.' });
  }

  try {
    const genre = chosen.normalizedGenres || [];
    const searchQuery = genre.length ? genre[0] : chosen.title;

    const pool = await catalogueSearch(searchQuery, 20);
    const recommendations = pool
      .filter((book) => book.id !== chosen.id)
      .filter((book) => !isEditorialTitle(book))
      .filter((book) => !isSameSeries(book, chosen))
      .map((book) => ({ ...book, matchScore: score(book, chosen) }))
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 6);

    return res.json(recommendations);
  } catch (error) {
    console.error('Recommendation generation failed:', error);
    return res.status(500).json({ error: 'Failed to generate recommendations.' });
  }
});

app.post('/api/auth/register', requireDatabase, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);

    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );

    const user = result.rows[0];
    return res.status(201).json({ token: userToken(user), user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error('Register failed:', error);
    return res.status(500).json({ error: 'Unable to create your account right now.' });
  }
});

app.post('/api/auth/login', requireDatabase, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await db.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.json({
      token: userToken(user),
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ error: 'Unable to sign you in right now.' });
  }
});

app.get('/api/me', requireDatabase, requireUser, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT book_id, book, rating, saved_at FROM saved_books WHERE user_id = $1 ORDER BY saved_at DESC',
      [req.user.id]
    );

    return res.json(result.rows);
  } catch (error) {
    console.error('Fetch saved books failed:', error);
    return res.status(500).json({ error: 'Unable to load your saved books.' });
  }
});

app.post('/api/saved', requireDatabase, requireUser, async (req, res) => {
  const book = req.body.book;

  if (!book?.id || !book.title) {
    return res.status(400).json({ error: 'A valid book is required.' });
  }

  try {
    const existing = await db.query(
      'SELECT 1 FROM saved_books WHERE user_id = $1 AND book_id = $2',
      [req.user.id, book.id]
    );

    if (existing.rows.length) {
      return res.status(409).json({ error: 'This book is already saved.' });
    }

    const result = await db.query(
      `INSERT INTO saved_books (user_id, book_id, book, rating)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, book.id, JSON.stringify(book), 0]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Save book failed:', error);
    return res.status(500).json({ error: 'Unable to save this book.' });
  }
});

app.patch('/api/saved/:bookId/rating', requireDatabase, requireUser, async (req, res) => {
  const rating = Number(req.body.rating);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be an integer between 1 and 5.' });
  }

  try {
    const result = await db.query(
      'UPDATE saved_books SET rating = $1 WHERE user_id = $2 AND book_id = $3 RETURNING *',
      [rating, req.user.id, req.params.bookId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Saved book not found.' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Update rating failed:', error);
    return res.status(500).json({ error: 'Unable to update the rating.' });
  }
});

app.delete('/api/saved/:bookId', requireDatabase, requireUser, async (req, res) => {
  try {
    await db.query('DELETE FROM saved_books WHERE user_id = $1 AND book_id = $2', [
      req.user.id,
      req.params.bookId,
    ]);

    return res.status(204).send();
  } catch (error) {
    console.error('Delete saved book failed:', error);
    return res.status(500).json({ error: 'Unable to remove this saved book.' });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Leafmark API is running at http://localhost:${PORT}`);
});
