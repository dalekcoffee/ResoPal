// A `Sync<Uri>` field is a string with a leading `@`. Without it the field loads
// as null and the asset silently never loads.
//
// `Elements.Core/DataTreeValue.cs` is the whole story:
//
//   UpdateValue(Uri url)  ->  Value = "@" + url.ToString()
//   IsURL                 ->  Value is string, Length > 1, [0] == '@' && [1] != '@'
//   ExtractURL()          ->  throws "DataTreeValue isn't an URL" unless IsURL,
//                             then returns new Uri(text.Substring(1))
//
// So `@` is a type tag, not decoration, and `@@` is the escape for a plain string
// that really does begin with an `@` (see `PreprocessString`). A URL written
// without it is not a URL at all: the load throws, the field ends up null, and
// what you get in-world is a texture with no image and no error anywhere.
//
// This cost a whole drag-test. The deck probe wrote `https://…/img/TD01-001?w=512`
// into `StaticTexture2D.URL`; the package validated, round-tripped byte-identical
// and had every reference resolved, and in-world all three cards were blank with a
// null URL. The stock Deck Maker export carries 62 URL values and every single one
// is marked - which is what makes it usable as an oracle here.
//
// The rule is narrow on purpose. A ProtoFlux request node also has a field called
// `URL`, but it holds a *reference* to the node feeding it, and a plain string
// field that happens to contain a url - the panel's `ResoPal/url` variable, or the
// `ValueObjectInput<string>` behind each button - is a string and must NOT be
// marked. So: a field named `URL` (or ending in it), whose value is a string that
// is not a guid reference.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const URL_FIELD = /(^|[a-z])URL$/i;

export const isUrlValueField = (key, value) =>
  URL_FIELD.test(key) && typeof value === 'string' && value !== '' && !GUID.test(value);

/** Every `Sync<Uri>` value in a document, split by whether it carries the marker. */
export function scanUrlFields(doc) {
  const marked = [], unmarked = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && isUrlValueField(k, v.Data)) {
        (v.Data.startsWith('@') && v.Data[1] !== '@' ? marked : unmarked).push({ field: k, value: v.Data });
      }
      walk(v);
    }
  })(doc);
  return { marked, unmarked };
}

/** Mark a url for a `Sync<Uri>` field. Idempotent, so it is safe on an already-marked value. */
export const asUrl = (url) => (String(url).startsWith('@') ? String(url) : '@' + url);
