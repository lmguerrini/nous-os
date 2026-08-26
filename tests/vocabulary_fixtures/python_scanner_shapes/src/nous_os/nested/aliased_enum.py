"""Fixture module: an Enum declared through an aliased import, one subdirectory
below src/nous_os.
"""

from enum import Enum as _AliasedEnum


class NestedAliasedKind(_AliasedEnum):
    ONE = "one"
    TWO = "two"
