from __future__ import annotations


def test_tag_template_crud_and_sync(client):
    created = client.post("/api/tag-templates", json={"name": "光线", "color": "#f59e0b", "values": ["强", "弱"]})
    assert created.status_code == 201, created.text
    template = created.json()
    assert template["values"] == ["强", "弱"]

    duplicate = client.post("/api/tag-templates", json={"name": "光线"})
    assert duplicate.status_code == 409

    updated = client.patch(f"/api/tag-templates/{template['id']}", json={"values": ["强", "中", "弱"]})
    assert updated.status_code == 200
    assert updated.json()["values"] == ["强", "中", "弱"]

    listed = client.get("/api/tag-templates").json()
    assert [item["name"] for item in listed] == ["光线"]

    # 同步到数据源:创建同名枚举标签
    dataset = client.post("/api/source-datasets", json={"name": "tag-lib-src"}).json()
    synced = client.post(f"/api/tag-templates/sync/{dataset['id']}")
    assert synced.status_code == 200
    tags = client.get(f"/api/source-datasets/{dataset['id']}/tags").json()
    assert len(tags) == 1
    assert tags[0]["name"] == "光线"
    assert tags[0]["values"] == ["强", "中", "弱"]

    # 库更新取值后再同步:数据源标签同步刷新
    client.patch(f"/api/tag-templates/{template['id']}", json={"values": ["弱"]})
    client.post(f"/api/tag-templates/sync/{dataset['id']}")
    tags = client.get(f"/api/source-datasets/{dataset['id']}/tags").json()
    assert tags[0]["values"] == ["弱"]

    removed = client.delete(f"/api/tag-templates/{template['id']}")
    assert removed.status_code == 204
    assert client.get("/api/tag-templates").json() == []


def test_material_type_crud_and_source_dataset_attribute(client):
    """素材类型库 CRUD + 数据源多选属性 + 改名/删除级联。"""
    # 库:创建/重名 409
    first = client.post("/api/material-types", json={"name": "可见光图片", "description": "白天拍摄"})
    assert first.status_code == 201, first.text
    visible = first.json()
    assert client.post("/api/material-types", json={"name": "可见光图片"}).status_code == 409
    infrared = client.post("/api/material-types", json={"name": "红外视频"}).json()

    listed = client.get("/api/material-types").json()
    assert [item["name"] for item in listed] == ["可见光图片", "红外视频"]

    # 数据源:创建带素材类型;未知类型 409
    created = client.post(
        "/api/source-datasets",
        json={"name": "风机巡检素材", "material_types": ["可见光图片", "红外视频"]},
    )
    assert created.status_code == 201, created.text
    dataset_id = created.json()["id"]
    assert created.json()["material_types"] == ["可见光图片", "红外视频"]

    unknown = client.post("/api/source-datasets", json={"name": "bad", "material_types": ["不存在"]})
    assert unknown.status_code == 409
    assert "素材类型不存在" in unknown.json()["error"]["message"]

    # 更新多选
    updated = client.patch(f"/api/source-datasets/{dataset_id}", json={"material_types": ["可见光图片"]})
    assert updated.json()["material_types"] == ["可见光图片"]

    # 类型改名 → 数据源引用级联更新
    renamed = client.patch(f"/api/material-types/{visible['id']}", json={"name": "可见光照片"})
    assert renamed.status_code == 200
    after_rename = next(item for item in client.get("/api/source-datasets").json() if item["id"] == dataset_id)
    assert after_rename["material_types"] == ["可见光照片"]

    # 删除类型 → 数据源引用清理
    client.patch(f"/api/source-datasets/{dataset_id}", json={"material_types": ["可见光照片", "红外视频"]})
    assert client.delete(f"/api/material-types/{infrared['id']}").status_code == 204
    after_delete = next(item for item in client.get("/api/source-datasets").json() if item["id"] == dataset_id)
    assert after_delete["material_types"] == ["可见光照片"]

    assert client.delete(f"/api/material-types/{visible['id']}").status_code == 204
    assert client.get("/api/material-types").json() == []
