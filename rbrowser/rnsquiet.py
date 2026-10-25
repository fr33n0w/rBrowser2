"""Reading what Reticulum knows about a destination, without telling it.

Since RNS 1.5, Identity.recall() and recall_app_data() also mark the
destination as used. Attached to a shared instance (rnsd) that mark is a call
over its local RPC, every time: 10 ms when rnsd is idle, past a second when it
is busy. Showing a name or checking what an address is calls these on every
poll, so here they skip the mark. Sending and connecting still go through
RNS's own calls, so what is really used stays marked.
"""
import RNS


def recall(destination_hash, from_identity_hash=False):
    try:
        return RNS.Identity.recall(destination_hash, from_identity_hash=from_identity_hash, _no_use=True)
    except TypeError:       # older RNS: no _no_use, and no RPC either
        return RNS.Identity.recall(destination_hash, from_identity_hash)


def recall_app_data(destination_hash):
    try:
        return RNS.Identity.recall_app_data(destination_hash, _no_use=True)
    except TypeError:
        return RNS.Identity.recall_app_data(destination_hash)
