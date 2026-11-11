"""Bounded musical detail gestures, separate from the main lighting cadence."""
import numpy as np


def arrange_details(events, phrases, beats, phases, pulse_grid, accents):
    beats=np.asarray(beats,dtype=float);phases=np.asarray(phases,dtype=int)
    if len(beats)<2:return []
    details=[]
    main=np.array([e['time'] for e in accents])
    active=lambda t:any(p['kind']!='quiet' and p['start']<=t<p['end'] for p in phrases)
    clear=lambda t,distance:not len(main) or np.min(np.abs(main-t))>=distance
    drums=[e for e in events if e['type'] in ['kick','snare'] and e['strength']>=.30 and active(e['time'])]
    merged=[]
    for event in drums:
        if merged and event['time']-merged[-1]['time']<.065:
            if event['strength']>merged[-1]['strength']:merged[-1]=event
        else:merged.append(event)

    # Search EACH bar ending, independent of the broad four-bar scene labels.
    # A tom/body roll may be labelled kick by the band estimator, so require a
    # short run of faster attacks and a local density increase, not only snares.
    windows=[]
    spans=[]
    for phrase in phrases:
        if phrase['kind']=='quiet':continue
        if spans and abs(spans[-1][1]-phrase['start'])<.01:spans[-1][1]=phrase['end']
        else:spans.append([phrase['start'],phrase['end']])
    for index in np.flatnonzero(phases==0):
        end=beats[index]
        if not active(end-.05):continue
        local=np.diff(beats[max(0,index-8):index+1])
        period=float(np.median(local)) if len(local) else .5
        width=min(1.35,max(.8,period*4))
        start=end-width
        origin=next((lo for lo,hi in spans if lo<=end-.05<hi),start)
        prior_start=max(origin,start-4)
        history=start-.1-prior_start
        # A song entering on steady fast drums has no established contrast
        # yet. Do not call its first bar a fill using imaginary silent history.
        if history<1.8:continue
        for snare_only in [False,True]:
            pool=[e for e in (drums if snare_only else merged) if not snare_only or e['type']=='snare']
            hits=[e for e in pool if start<=e['time']<end-.025]
            previous=[e for e in pool if prior_start<=e['time']<start-.1]
            if len(hits)<(4 if snare_only else 5):continue
            gaps=np.diff([e['time'] for e in hits])
            fast=sum((gaps>=.075)&(gaps<=.20))
            rate=len(hits)/width;baseline=len(previous)/history
            if fast<(1 if snare_only else 3) or rate<max(2.8 if snare_only else 4.2,baseline*1.6):continue
            if windows and hits[0]['time']-windows[-1]['end']<1.1:continue
            windows.append({'start':hits[0]['time'],'end':end,'hits':hits})
            break
    for window in windows:
        eligible=[e for e in window['hits'] if clear(e['time'],.15)]
        chosen=[]
        for e in eligible:
            if not chosen or e['time']-chosen[-1]['time']>=.18:chosen.append(e)
        # No continuous roll of flashes: at most three punctuations per fill.
        if len(chosen)>3:chosen=[chosen[i] for i in np.linspace(0,len(chosen)-1,3).astype(int)]
        for i,e in enumerate(chosen):
            details.append({'time':e['time'],'type':'fill','strength':e['strength'],
                            'side':i%2,'windowStart':round(window['start'],4),'windowEnd':round(window['end'],4)})

    # A recurring snare answer on beats 2/4 is intentional backbeat, unlike an
    # arbitrary loud onset. Keep it only in moderate beat-level passages and
    # require another answer nearby. The very fast parts use fill gestures only.
    answers=[]
    for index,t in enumerate(beats):
        if phases[index]%2!=1:continue
        local=np.diff(beats[max(0,index-4):min(len(beats),index+5)])
        if not len(local) or np.median(local)<.35:continue
        near=[e for e in drums if e['type']=='snare' and e['strength']>=.45 and abs(e['time']-t)<=.055 and clear(e['time'],.18)]
        if near:
            e=min(near,key=lambda e:abs(e['time']-t))
            answers.append({**e,'side':0 if phases[index]==1 else 1,'beatIndex':index})
    for e in answers:
        if not any(0<abs(e['beatIndex']-other['beatIndex'])<=8 for other in answers):continue
        if any(abs(e['time']-d['time'])<.18 or d.get('windowStart',1e9)<=e['time']<=d.get('windowEnd',-1) for d in details):continue
        details.append({'time':e['time'],'type':'backbeat','strength':e['strength'],'side':e['side']})

    # Strong, sustained cymbal hits get broad haze and a small opening; the
    # baker only adds a direct bloom when reinforcing an existing main hit.
    # Absolute band
    # prominence excludes soft open-hat texture whose normalized novelty may
    # otherwise saturate like a crash. A hit can share a main drum's timestamp.
    last=-10.
    for e in events:
        if e['type']!='cymbal' or not e.get('crash') or not active(e['time']):continue
        if e.get('prominence',0)<.85 or e.get('sustain',0)<.18 or e['strength']<.45:continue
        if e['time']-last<1.1:continue
        details.append({'time':e['time'],'type':'cymbal','strength':min(1,e['prominence']/1.5),'side':-1})
        last=e['time']
    # Repeated sustained cymbal attacks can also carry a lighter open-hat
    # texture. Keep it beat-related and far below the main pulse, without the
    # wide crash bloom or beam opening. Instrument names remain estimates.
    cymbals=[e for e in events if e['type']=='cymbal' and active(e['time'])
             and e.get('prominence',0)>=.38 and e.get('sustain',0)>=.25 and e['strength']>=.35]
    subdivisions=np.sort(np.r_[beats,(beats[:-1]+beats[1:])*.5])
    last=-10.
    for e in cymbals:
        t=e['time']
        if t-last<.32 or np.min(abs(subdivisions-t))>.055:continue
        if any(d['type']=='cymbal' and abs(d['time']-t)<.18 for d in details):continue
        if not any(.18<abs(other['time']-t)<=2.2 for other in cymbals):continue
        details.append({'time':t,'type':'cymbal-texture','strength':e['strength'],'side':-1})
        last=t
    return sorted(details,key=lambda e:e['time'])
