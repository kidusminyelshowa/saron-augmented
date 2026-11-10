import numpy as np, json
from scipy.optimize import minimize
exec(open('score.py').read().split('for l,cs')[0])
best={}
starts={'background':cands['background']['ecc'],'logs':cands['logs']['ecc'],'woman':cands['woman']['sift_s'],'hand':cands['hand']['ecc'],
        'ensira':cands['background']['ecc'],'water':cands['background']['ecc']}
for l,A0 in starts.items():
  A0=np.array(A0,float)
  if l in ('ensira','water'):
    f=lambda p: -score(l,A0+np.array([[0,0,p[0]],[0,0,p[1]]]))
    # coarse grid then refine
    g=max(((f([dx,dy]),dx,dy) for dx in range(-16,17,2) for dy in range(-16,17,2)))
    g=min(((f([dx,dy]),dx,dy) for dx in range(-16,17,2) for dy in range(-16,17,2)))
    r=minimize(f,[g[1],g[2]],method='Nelder-Mead',options={'xatol':0.2,'fatol':1e-5})
    A=A0+np.array([[0,0,r.x[0]],[0,0,r.x[1]]])
  else:
    f=lambda p: -score(l,A0+np.array([[p[0]*.01,p[1]*.01,p[2]],[p[3]*.01,p[4]*.01,p[5]]]))
    r=minimize(f,np.zeros(6),method='Nelder-Mead',options={'xatol':0.05,'fatol':1e-5,'maxiter':1500,'initial_simplex':None})
    p=r.x; A=A0+np.array([[p[0]*.01,p[1]*.01,p[2]],[p[3]*.01,p[4]*.01,p[5]]])
  best[l]=A.tolist()
  print(l,'id',round(score(l,I),4),'start',round(score(l,A0),4),'opt',round(-r.fun,4),np.round(A,4).tolist())
json.dump(best,open('best.json','w'))
