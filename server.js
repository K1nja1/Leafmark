
  const comma = line.indexOf(',');
  return [line.slice(0, comma), line.slice(comma + 1).replace(/^"|"$/g, '')];
  return [line.slice(0, comma).replace(/^"|"$/g, ''), line.slice(comma + 1).replace(/^"|"$/g, '')];
}));
function normaliseBisacText(value) { return String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
const BISAC_ENTRIES = [...BISAC_BY_CODE].map(([code, category]) => {
  const details = category.split('/').map((part) => part.trim()).slice(1).filter((part) => part.toLowerCase() !== 'general');
  const aliases = [details.join(' ')];
  if (details.length === 1 && category.startsWith('Fiction /')) aliases.push(details[0]);
  return { code, category, aliases: [...new Set(aliases.map(normaliseBisacText).filter((alias) => alias.length >= 4))] };
});
const BISAC_GENRE_RULES = [
const BISAC_SYNONYM_RULES = [
  { code: 'FIC009000', terms: ['fantasy', 'magic', 'dragons', 'witchcraft', 'wizards'] },
const unique = (values = []) => [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];
function normaliseGenres(values = []) { const labels = unique(values).map((value) => value.toLowerCase()); return BISAC_GENRE_RULES.filter(({ terms }) => terms.some((term) => labels.some((label) => label.includes(term)))).map(({ code }) => code); }
function normaliseGenres(values = []) {
  const labels = unique(values).map(normaliseBisacText);
  const directMatches = BISAC_ENTRIES.filter(({ aliases }) => aliases.some((alias) => labels.some((label) => {
    const aliasWords = alias.split(' ');
    const labelWords = new Set(label.split(' '));
    return label === alias || (aliasWords.length > 1 && aliasWords.every((word) => labelWords.has(word)));
  }))).map(({ code }) => code);
  const synonymMatches = BISAC_SYNONYM_RULES.filter(({ terms }) => terms.some((term) => labels.some((label) => label.includes(normaliseBisacText(term))))).map(({ code }) => code);
  return unique([...directMatches, ...synonymMatches]);
}
function genreLabels(codes = []) { return codes.map((code) => BISAC_BY_CODE.get(code)).filter(Boolean).map((label) => label.replace(/^Fiction \/ /, '').replace(/ \/ General$/, '')); }
function genreSearchTerm(code) { const rule = BISAC_GENRE_RULES.find((item) => item.code === code); return rule?.terms[0] || ''; }
function genreSearchTerm(code) { const rule = BISAC_SYNONYM_RULES.find((item) => item.code === code); return rule?.terms[0] || BISAC_ENTRIES.find((item) => item.code === code)?.aliases[0] || ''; }
function openLibraryBook(book) { const rawSubjects = unique(book.subject).slice(0, 12); const normalizedGenres = normaliseGenres(rawSubjects); return { id: `ol:${book.key}`, title: book.title || 'Untitled', author: book.author_name?.[0] || 'Unknown author', year: book.first_publish_year || null, cover: cover(book.cover_i), rawSubjects, normalizedGenres, subjects: genreLabels(normalizedGenres), ratingCount: 0, averageRating: null, source: 'Open Library' }; }
app.get('/api/books/search', async (req, res) => { const query = String(req.query.q || '').trim(); if (!query) return res.status(400).json({ error: 'A search query is required.' }); try { const books = await catalogueSearch(query); const sources = { openLibrary: books.filter((book) => book.sources.includes('Open Library')).length, googleBooks: books.filter((book) => book.sources.includes('Google Books')).length }; res.json({ books, sources }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.get('/api/genres', (req, res) => { const query = normaliseBisacText(req.query.q); const genres = BISAC_ENTRIES.filter(({ code, category }) => !query || normaliseBisacText(`${code} ${category}`).includes(query)); res.json({ total: BISAC_ENTRIES.length, genres }); });
app.post('/api/books/recommendations', async (req, res) => { const chosen = req.body.book; if (!chosen?.title) return res.status(400).json({ error: 'A book is required.' }); try { const genre = chosen.normalizedGenres?.[0]; const query = genreSearchTerm(genre) || chosen.author || chosen.title; const candidates = await catalogueSearch(query, 30, Boolean(genre)); const books = candidates.filter((book) => book.id !== chosen.id && !isSameSeries(book, chosen) && !isEditorialTitle(book)).map((book) => ({ ...book, similarityScore: score(book, chosen), popularityScore: readerPopularity(book) })).filter((book) => book.similarityScore > 0 || (book.sources.includes('Google Books') && book.normalizedGenres.length > 0)).sort((a, b) => b.popularityScore - a.popularityScore || b.similarityScore - a.similarityScore).slice(0, 6); res.json({ books }); } catch (error) { res.status(502).json({ error: error.message }); } });
