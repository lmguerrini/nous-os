"""A fixture module used only to prove the excluded-vocabulary source scan can fail.

Real source under src/nous_os is clean of this vocabulary; this file exists solely
under tests/vocabulary_fixtures/ so the control has a synthetic tree to scan.
"""

# This comment treats the graph like a mycelium network, which is exactly the
# ontology the real canonical layer is checked never to contain.
GREETING = "hello"
