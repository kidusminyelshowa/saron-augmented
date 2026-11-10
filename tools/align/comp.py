import cv2, numpy as np, json
best=json.load(open('best.json'))
photo=cv2.resize(cv2.imread('/home/claude/saron-augmented/tools/targets/mural-001/wall-photo.jpg'),(720,1170))
order=['background','logs','woman','ensira','water','hand']
def comp(fit):
  out=np.zeros((1170,720,3),np.float32)
  for l in order:
    im=cv2.imread(f'{l}.png'); c=im[:1170].astype(np.float32); a=im[1170:2340,:,:1].astype(np.float32)/255
    if fit:
      A=np.float32(best[l]); c=cv2.warpAffine(c,A,(720,1170),borderMode=cv2.BORDER_REPLICATE); a=cv2.warpAffine(a,A,(720,1170),borderMode=cv2.BORDER_REPLICATE)[...,None]
    out=out*(1-a)+c*a
  return out.astype(np.uint8)
for name,f in (('before',False),('after',True)):
  c=comp(f); cv2.imwrite(f'comp_{name}.png',c)
  # edge overlay: photo edges green, animation edges magenta
  e1=cv2.Canny(cv2.GaussianBlur(cv2.cvtColor(photo,cv2.COLOR_BGR2GRAY),(5,5),0),40,100)
  e2=cv2.Canny(cv2.GaussianBlur(cv2.cvtColor(c,cv2.COLOR_BGR2GRAY),(5,5),0),40,100)
  o=(photo*0.35).astype(np.uint8); o[e1>0]=(0,255,0); o[e2>0]=(255,0,255); o[(e1>0)&(e2>0)]=(255,255,255)
  cv2.imwrite(f'edges_{name}.png',o[:900])
  cv2.imwrite(f'blend_{name}.png',cv2.addWeighted(photo,0.5,c,0.5,0)[:900])
s=np.concatenate([cv2.imread('blend_before.png'),np.full((900,10,3),255,np.uint8),cv2.imread('blend_after.png')],1)
cv2.imwrite('blend_compare.png',s)
s=np.concatenate([cv2.imread('edges_before.png'),np.full((900,10,3),255,np.uint8),cv2.imread('edges_after.png')],1)
cv2.imwrite('edges_compare.png',s)
