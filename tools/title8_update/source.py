"""Bounded, official-origin OLRC retrieval. All downloads remain untrusted."""
import hashlib
from html.parser import HTMLParser
import io
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

DOWNLOAD_PAGE = 'https://uscode.house.gov/download.html'
NAMESPACE = 'http://xml.house.gov/schemas/uslm/1.0'
MAX_BYTES = 64 * 1024 * 1024
RELEASE = r'\d+-\d+(?:not\d+-\d+)*'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def release_key(release):
    if not re.fullmatch(RELEASE, release):
        raise ValueError('Invalid OLRC release identifier')
    return tuple(map(int, release.split('not')[0].split('-')))


def official_url(url):
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != 'https' or parts.netloc != 'uscode.house.gov'
            or parts.username or parts.password or parts.fragment or parts.query
            or not (parts.path.startswith('/download/') or parts.path == '/download.html') or '..' in parts.path):
        raise ValueError('Source URL must be an HTTPS OLRC download URL')
    return url


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.hrefs.append(dict(attrs).get('href', ''))


def discover(page):
    links = Links()
    links.feed(page)
    found = set()
    for href in links.hrefs:
        match = re.search(r'/xml_usc08@(' + RELEASE + r')\.zip$', href)
        if match:
            # Older captured pages used links relative to /download/; current
            # pages use download/... links relative to the origin root.
            base = 'https://uscode.house.gov/download/' if href.startswith('releasepoints/') else DOWNLOAD_PAGE
            found.add((match[1], official_url(urllib.parse.urljoin(base, href))))
    if len(found) != 1:
        raise ValueError('OLRC page has no unambiguous current Title 8 ZIP link (publisher may be unavailable)')
    return next(iter(found))


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        official_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url):
    official_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'INASearch Title 8 source updater'})
    with urllib.request.build_opener(OfficialRedirect()).open(request, timeout=45) as response:
        official_url(response.geturl())
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('OLRC response exceeds the download size limit')
    return data


def extract_zip(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) != 1 or members[0].filename != 'usc08.xml' or members[0].file_size > MAX_BYTES:
                raise ValueError('Unexpected Title 8 archive members or uncompressed size')
            return archive.read(members[0])
    except (zipfile.BadZipFile, RuntimeError) as error:
        raise ValueError('Publisher did not return a valid Title 8 ZIP') from error


def validate_xml(data, release):
    release_key(release)
    if len(data) > MAX_BYTES or re.search(br'<!\s*(?:DOCTYPE|ENTITY)', data, re.I):
        raise ValueError('Unsupported XML declarations or size')
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        raise ValueError('Invalid USLM XML') from error
    ns = {'u': NAMESPACE}
    if root.tag != '{' + NAMESPACE + '}uscDoc' or root.get('identifier') != '/us/usc/t8':
        raise ValueError('Unsupported USLM schema or document is not Title 8')
    if (root.findtext('u:meta/u:docNumber', namespaces=ns) != '8'
            or root.findtext('u:meta/u:docPublicationName', namespaces=ns) != 'Online@' + release):
        raise ValueError('Title 8 XML release metadata does not match the download')
    return root
