"""Built-in functions a variable can use, with typed, named arguments.

The editor shows each function's source exactly as written here, and turning a
primitive into a custom Python function starts from this source, so keep each
one short and readable. Code generation calls them with keyword arguments named
after their slots. They must stay pure: no I/O, randomness or global state.

The TypeScript engine in workbench (src/lib/algorithmHypothesis) implements the
same functions and stores these sources; the golden tests keep them in sync.
"""

from __future__ import annotations

import inspect
import math
from dataclasses import dataclass, field
from typing import Any, Callable

from algorithm_hypothesis import vartypes as vt
from algorithm_hypothesis.values import Distribution, K, Pair, Position, T, Token, V, show

# ----------------------------------------------------------------- functions


def position_id(token: str, specials: list[str]) -> Pair[Position, str]:
    """The token's position ID, stored as position ID : token. Each distinct
    special token (such as a name) gets the next ID in order of first
    appearance, so a name mentioned again gets its first mention's ID.
    `specials` are the special tokens up to this one; a possessive ('s) is
    ignored when comparing them."""

    def name(t):
        return str(t).strip().split("'")[0]

    ids = {}
    for t in specials:
        if t is not None:
            ids.setdefault(name(t), len(ids) + 1)
    if token is None or name(token) not in ids:
        return None
    return Pair(ids[name(token)], token)


def copy(x: T) -> T:
    """The value, unchanged, in another cell. Copying a token carries the
    token itself."""
    return x


def pair(key: K, value: V) -> Pair[K, V]:
    """Bind a key to a value."""
    return Pair(key, value)


def retrieve(key: K, pairs: list[Pair[K, V]], *, match: str = "key") -> V | None:
    """The value of the first pair whose key equals `key`, the way attention
    matches a query against keys and reads the matching value. With
    match="value", the first value equal to `key`: dereferencing a pointer,
    which finds nothing if that value isn't in context."""
    for p in pairs:
        if key is None or not isinstance(p, Pair):
            continue
        if (p.key if match == "key" else p.value) == key:
            return p.value
    return None


def index(i: Position, values: list[V]) -> V | None:
    """The i-th value, counting from 1."""
    if isinstance(i, int) and 1 <= i <= len(values):
        return values[i - 1]
    return None


def key_of(pair: Pair[K, V]) -> K | None:
    """The key of a key : value pair, such as the position ID of 4:Tim."""
    return pair.key if isinstance(pair, Pair) else None


def value_of(pair: Pair[K, V]) -> V | None:
    """The value of a key : value pair, such as the token of 4:Tim."""
    return pair.value if isinstance(pair, Pair) else None


def mixture(
    P: Position,
    L: str,
    R: str,
    bindings: list[Pair[str, str]],
    *,
    w_pos: float = 3.0,
    sigma: float = 0.7,
    w_lex: float = 2.6,
    w_ref: float = 2.6,
) -> Distribution:
    """Eq. 2 of Gur-Arieh et al.: a Gaussian around group P, plus a bump at
    the group whose key is L and one at the group whose value is R."""
    scores = []
    for i, b in enumerate(bindings, start=1):
        b = b if isinstance(b, Pair) else Pair(None, None)
        s = w_pos * math.exp(-((i - P) ** 2) / (2 * sigma**2)) if isinstance(P, int) else 0.0
        s += w_lex if L is not None and b.key == L else 0.0
        s += w_ref if R is not None and b.value == R else 0.0
        scores.append(s)
    top = max(scores, default=0.0)
    weights = [math.exp(s - top) for s in scores]
    total = sum(weights) or 1.0
    return Distribution(tuple((show(b.value) if isinstance(b, Pair) else "∅", w / total) for b, w in zip(bindings, weights)))


def constant(*, value: str = "", type: str = "string") -> str | int | None:
    """A fixed value."""
    if value == "":
        return None
    return value if type == "string" else int(value)


# ------------------------------------------------- helpers for generated code


def as_token(text, index):
    """Wrap a token's text, as carried through the residual stream, with its index."""
    return None if text is None else Token(text, index)


def render(tok):
    """raw_input for generated models: the prompt's tokens, space-separated."""
    return " ".join(str(t).strip() for t in tok)


def display(value):
    """raw_output for generated models: the output as shown in the grid."""
    return show(value)


# ------------------------------------------------------------------ registry


@dataclass(frozen=True)
class Slot:
    name: str
    type: dict  # a pattern; {"kind": "list", ...} means the slot takes a list

    @property
    def many(self) -> bool:
        return self.type["kind"] == "list"


@dataclass(frozen=True)
class Option:
    name: str
    default: Any
    choices: tuple | None = None


@dataclass(frozen=True)
class Primitive:
    name: str
    label: str
    slots: tuple[Slot, ...]
    returns: dict | None  # None: set by the "type" option (constant)
    options: tuple[Option, ...] = field(default_factory=tuple)
    fn: Callable[..., Any] | None = None
    # Slots and return type under other option values, if they differ.
    retype: Callable[[dict], tuple[tuple[Slot, ...], dict | None] | None] | None = None

    @property
    def source(self) -> str:
        return inspect.getsource(self.fn)

    def signature(self, options: dict) -> tuple[tuple[Slot, ...], dict | None]:
        """Slots and return type for these option values."""
        alt = self.retype(options) if self.retype else None
        return alt or (self.slots, self.returns)


_K, _V, _T = vt.var("K"), vt.var("V"), vt.var("T")


def _retrieve_by_value(options: dict):
    # Matching on values: the key is compared with each pair's value.
    if options.get("match", "key") == "value":
        return (Slot("key", _V), Slot("pairs", vt.list_of(vt.pair(_K, _V)))), _V
    return None


PRIMITIVES: dict[str, Primitive] = {
    p.name: p
    for p in [
        Primitive(
            "position_id",
            "Position ID",
            (Slot("token", vt.STRING), Slot("specials", vt.list_of(vt.STRING))),
            vt.pair(vt.POSITION, vt.STRING),
            (),
            position_id,
        ),
        Primitive("copy", "Copy", (Slot("x", _T),), _T, (), copy),
        Primitive("pair", "Pair", (Slot("key", _K), Slot("value", _V)), vt.pair(_K, _V), (), pair),
        Primitive(
            "retrieve",
            "Retrieve",
            (Slot("key", _K), Slot("pairs", vt.list_of(vt.pair(_K, _V)))),
            _V,
            (Option("match", "key", ("key", "value")),),
            retrieve,
            _retrieve_by_value,
        ),
        Primitive("index", "Index", (Slot("i", vt.POSITION), Slot("values", vt.list_of(_V))), _V, (), index),
        Primitive("key_of", "KeyOf", (Slot("pair", vt.pair(_K, _V)),), _K, (), key_of),
        Primitive("value_of", "ValueOf", (Slot("pair", vt.pair(_K, _V)),), _V, (), value_of),
        Primitive(
            "mixture",
            "Mixture (Eq. 2)",
            (
                Slot("P", vt.POSITION),
                Slot("L", vt.STRING),
                Slot("R", vt.STRING),
                Slot("bindings", vt.list_of(vt.pair(vt.STRING, vt.STRING))),
            ),
            vt.STRING,
            (Option("w_pos", 3.0), Option("sigma", 0.7), Option("w_lex", 2.6), Option("w_ref", 2.6)),
            mixture,
        ),
        Primitive(
            "constant",
            "Constant",
            (),
            None,
            (Option("value", ""), Option("type", "string", ("string", "int", "position"))),
            constant,
        ),
    ]
}
