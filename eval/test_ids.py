"""Conservative reconciliation of official test IDs and pinned parser IDs."""
def reconcile_test_ids(expected,observed,repo):
    """Map official dataset test IDs to pinned SWE-bench parser output.

    Django's Verified snapshot omits the repeated method suffix emitted by its
    unittest runner. Match only the exact class and exact method, and aggregate
    parametrized subtests conservatively: any failure/error dominates.
    """
    mapped,aliases={},{}
    for case in expected:
        if case in observed:
            mapped[case]=observed[case];aliases[case]=[case];continue
        if repo!='django/django':continue
        match=__import__('re').fullmatch(r'(test_[A-Za-z0-9_]+) \(([^()]+)\)',case)
        if not match:continue
        method,klass=match.groups();candidates=[]
        for actual,status in observed.items():
            prefix=f'{method} ({klass}.{method})'
            if actual==prefix or actual.startswith(prefix+' '):candidates.append((actual,status))
        if candidates:
            statuses={status for _,status in candidates}
            if not any(key==f'{method} ({klass}.{method})' for key,_ in candidates) and not statuses.intersection({'FAILED','ERROR'}):continue
            mapped[case]=next((x for x in ('ERROR','FAILED','SKIPPED') if x in statuses),'PASSED' if statuses=={'PASSED'} else 'ERROR')
            aliases[case]=[key for key,_ in candidates]
    return mapped,aliases

