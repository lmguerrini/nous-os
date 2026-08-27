"""Fixture module: every closed-vocabulary base the standard `enum` module
exports, under a plain import and a dotted reference, both ordinary shapes a
reviewer showed the old Enum-only base test missed entirely.
"""

import enum
from enum import Flag, IntEnum, IntFlag, ReprEnum, StrEnum


class PlainStrEnum(StrEnum):
    ONE = "one"


class PlainIntEnum(IntEnum):
    ONE = 1


class PlainIntFlag(IntFlag):
    ONE = 1


class PlainFlag(Flag):
    ONE = 1


class PlainReprEnum(ReprEnum):
    ONE = 1


class DottedStrEnum(enum.StrEnum):
    ONE = "one"
